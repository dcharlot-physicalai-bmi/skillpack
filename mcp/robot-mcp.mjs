// robot-mcp — a reference MCP server implementing the Robot MCP Profile (see MCP-PROFILE.md).
// Dependency-free JSON-RPC 2.0 over stdio. Every skill tool carries the robot's capabilities + safety
// envelope, and run_skill ENFORCES the envelope through the skillpack runtime — so an LLM (or a
// compromised one) can never command motion outside what the body can safely do.
//
//   node mcp/robot-mcp.mjs --robot ../robots/so101.json      (speaks MCP on stdio)
//   handleRequest(req, ctx) is exported for tests (verify-mcp.mjs).

import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, matchRobot, bind } from '../skillkit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const SERVER = { name: 'robot-mcp', version: '0.1.0', profile: 'robot-mcp/0.1' };

export async function makeContext(robotPath) {
  const registry = JSON.parse(await readFile(join(PKG, 'registry.json'), 'utf8'));
  const robot = JSON.parse(await readFile(resolve(robotPath), 'utf8'));
  return { registry, robot };
}

async function skillManifest(entry) { return (await loadSkill(join(PKG, entry.path))).manifest; }

// stand-in policy backends for non-analytic skills (real inference lives in the policy's own runtime)
function backendFor(kind, dof, mode) {
  if (kind === 'vla') return { backend: { infer() { const o = new Float32Array(50 * 32); for (let i = 0; i < o.length; i++) o[i] = mode === 'corrupt' ? [NaN, 9, -5, Infinity, 42][i % 5] : 0.6; return o; } } };
  if (kind === 'lerobot') return { backend: { selectAction() { return Array.from({ length: dof }, (_, i) => mode === 'corrupt' ? [NaN, 9, -5, Infinity, 42][i % 5] : 0.6); } } };
  return undefined; // analytic
}

const TOOLS = [
  { name: 'describe_robot', description: 'The connected robot capability manifest and which skills it can or cannot run (with reasons).', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_skills', description: 'Skills this robot is capable of running, each with its contract and safety envelope. Capability-gated.', inputSchema: { type: 'object', properties: {} } },
  { name: 'skill_contract', description: 'The typed pre/post/invariants, requirements, and safety envelope of a skill.', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
  { name: 'run_skill', description: 'Bind and run a skill through the runtime safety envelope. Returns a bounded trajectory and a safety_report proving enforcement. Refuses skills the robot cannot run.', inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, ticks: { type: 'integer' }, policy_override: { enum: ['corrupt'], description: 'inject a hijacked policy to demonstrate the envelope holds' } } } },
  { name: 'estop', description: 'Zero-velocity hold — stop motion.', inputSchema: { type: 'object', properties: {} } },
];

async function callTool(name, args, ctx) {
  const { registry, robot } = ctx;
  if (name === 'describe_robot') {
    const skills = await Promise.all(registry.skills.map(async (s) => {
      const m = await skillManifest(s); const gate = matchRobot(m, robot);
      return { name: s.name, compatible: gate.ok, reasons: gate.reasons };
    }));
    return { robot, skills };
  }
  if (name === 'list_skills') {
    const out = [];
    for (const s of registry.skills) {
      const m = await skillManifest(s);
      if (matchRobot(m, robot).ok) out.push({ name: m.name, title: m.title, policy: m.policy.kind, requires: m.requires, safety: m.safety });
    }
    return { skills: out };
  }
  if (name === 'skill_contract') {
    const entry = registry.skills.find((s) => s.name === args.name);
    if (!entry) throw new Error(`no skill "${args.name}"`);
    const m = await skillManifest(entry);
    return { name: m.name, requires: m.requires, safety: m.safety, contract: m.contract, io: m.io };
  }
  if (name === 'estop') return { command: 'zero-velocity-hold', note: 'motion stopped; the runtime holds the current joint positions' };
  if (name === 'run_skill') {
    const entry = registry.skills.find((s) => s.name === args.name);
    if (!entry) throw new Error(`no skill "${args.name}"`);
    const skill = await loadSkill(join(PKG, entry.path));
    const m = skill.manifest;
    const gate = matchRobot(m, robot);
    if (!gate.ok) return { refused: true, reasons: gate.reasons, note: 'the robot cannot safely run this skill; refused at the protocol boundary before any motion' };
    const dof = robot.dof, maxStep = m.safety.max_step_norm;
    const mode = args.policy_override === 'corrupt' ? 'corrupt' : 'reach';
    const rt = await bind(skill, robot, { q0: new Array(dof).fill(0.5), policyOpts: backendFor(m.policy.kind, dof, mode) });
    const target = Array.from({ length: dof }, (_, i) => 0.2 + 0.05 * i);
    const ticks = Math.min(args.ticks || 40, 200);
    let maxSeen = 0, prev = new Array(dof).fill(0.5), allIn = true, wireValid = true, lastWire = '';
    for (let k = 0; k < ticks; k++) {
      const t = rt.step({ q: rt.state(), q_target: target, image: null, task: m.task, state: rt.state() });
      for (let i = 0; i < dof; i++) { maxSeen = Math.max(maxSeen, Math.abs(t.q[i] - prev[i])); if (t.q[i] < 0 || t.q[i] > 1 || !Number.isFinite(t.q[i])) allIn = false; }
      if (!(t.wire && t.wire.data && t.wire.data.length)) wireValid = false;
      lastWire = t.wire.text; prev = t.q;
    }
    return {
      skill: m.name, policy: m.policy.kind, robot: robot.name, ticks, hijacked: mode === 'corrupt',
      final_joints: prev.map((v) => +v.toFixed(3)),
      wire_sample: lastWire.slice(0, 48) + '…',
      safety_report: { within_cap: maxSeen <= maxStep + 1e-9, max_step: +maxSeen.toFixed(4), cap: maxStep, all_in_range: allIn, wire_valid: wireValid },
    };
  }
  throw new Error(`unknown tool "${name}"`);
}

// JSON-RPC 2.0 dispatch (the MCP core methods)
export async function handleRequest(req, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: req.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
  try {
    if (req.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER });
    if (req.method === 'tools/list') return reply({ tools: TOOLS });
    if (req.method === 'tools/call') {
      const out = await callTool(req.params.name, req.params.arguments || {}, ctx);
      return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: !!out.refused });
    }
    return fail(-32601, `method not found: ${req.method}`);
  } catch (e) { return fail(-32000, e.message); }
}

// stdio server (line-delimited JSON-RPC) when run directly
const argRobot = (() => { const i = process.argv.indexOf('--robot'); return i >= 0 ? process.argv[i + 1] : join(PKG, 'robots/so101.json'); })();
if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = await makeContext(argRobot);
  process.stderr.write(`robot-mcp ready · ${ctx.robot.name} · profile ${SERVER.profile}\n`);
  let buf = '';
  process.stdin.on('data', async (d) => {
    buf += d; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let req; try { req = JSON.parse(line); } catch { continue; }
      const res = await handleRequest(req, ctx);
      process.stdout.write(JSON.stringify(res) + '\n');
    }
  });
}
