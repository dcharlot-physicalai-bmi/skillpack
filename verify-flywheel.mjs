// verify-flywheel.mjs — the WHOLE registry, one contract. Every skill (analytic · vla · lerobot),
// across morphologies and checkpoints, is bound to a compatible robot and driven through the runtime
// safety envelope. The claim: no matter the policy kind, the envelope holds and a valid wire packet
// comes out — so growing the registry never grows the attack surface.
//   node v2/skillpack/verify-flywheel.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, matchRobot, bind } from './skillkit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const reg = JSON.parse(await readFile(resolve(HERE, 'registry.json'), 'utf8'));
const robots = [];
for (const r of reg.robots) robots.push(JSON.parse(await readFile(resolve(HERE, r.path), 'utf8')));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

// stand-ins for the forward pass of non-analytic policies (real weights run in their own runtimes)
function vlaBackend(mode) { return { infer() {
  const out = new Float32Array(50 * 32);
  for (let i = 0; i < out.length; i++) out[i] = mode === 'ood' ? [NaN, 9, -5, Infinity, 42][i % 5] : 0.6;
  return out; } }; }
function lerobotBackend(dof, mode) { return { selectAction() {
  return Array.from({ length: dof }, (_, i) => mode === 'ood' ? [NaN, 9, -5, Infinity, 42][i % 5] : 0.6); } }; }
const backendFor = (kind, dof, mode) => kind === 'vla' ? { backend: vlaBackend(mode) } : kind === 'lerobot' ? { backend: lerobotBackend(dof, mode) } : undefined;

// codec-agnostic packet sanity + the safety invariant. Range depends on the action space:
// position commands live in [0,1]; velocity commands in [-maxSpeed, maxSpeed].
function okTick(t, range = [0, 1]) {
  const bytesOk = t.wire && t.wire.data && t.wire.data.length > 0;
  const bounded = t.q.every((v) => Number.isFinite(v) && v >= range[0] - 1e-9 && v <= range[1] + 1e-9);
  return bytesOk && bounded;
}

console.log(h(`flywheel · ${reg.skills.length} skills × the one contract`));

for (const entry of reg.skills) {
  const skill = await loadSkill(resolve(HERE, entry.path));
  const m = skill.manifest;
  const kind = m.policy.kind;
  const robot = robots.find((r) => matchRobot(m, r).ok);
  console.log(h(`${entry.name}  ${kind}${entry.checkpoint ? ' · ' + entry.checkpoint : ''}`));
  check('gates to a compatible robot', !!robot, robot ? robot.name : 'NONE compatible');
  if (!robot) continue;

  const dof = robot.dof;
  const velocity = m.requires.actuation === 'velocity';
  const cap = velocity ? m.safety.max_accel_norm : m.safety.max_step_norm;         // accel vs position-step cap
  const range = velocity ? [-m.safety.max_speed_norm, m.safety.max_speed_norm] : [0, 1];
  const target = Array.from({ length: dof }, (_, i) => 0.2 + 0.05 * i);

  // normal run
  const rt = await bind(skill, robot, { q0: new Array(dof).fill(0.5), policyOpts: backendFor(kind, dof, 'reach') });
  let bad = false, maxSeen = 0, prev = rt.state();
  for (let k = 0; k < 40; k++) {
    const t = rt.step({ q: rt.state(), q_target: target, pose: rt.state(), goal: target, image: null, task: 'x', state: rt.state() });
    for (let i = 0; i < dof; i++) maxSeen = Math.max(maxSeen, Math.abs(t.q[i] - prev[i]));
    prev = t.q; if (!okTick(t, range)) bad = true;
  }
  check(`runs on ${robot.name} → valid wire + bounded (40 ticks)`, !bad);
  check(`no tick exceeded the ${velocity ? 'accel' : 'velocity'} cap`, maxSeen <= cap + 1e-9, `max ${maxSeen.toFixed(3)} ≤ ${cap}`);

  // adversarial (only policies with an injectable backend can be corrupted; analytic is trusted-by-construction)
  if (kind === 'vla' || kind === 'lerobot') {
    const rtO = await bind(skill, robot, { q0: new Array(dof).fill(0.5), policyOpts: backendFor(kind, dof, 'ood') });
    let obad = false;
    for (let k = 0; k < 40; k++) { const t = rtO.step({ image: null, task: 'x', state: [] }); if (!okTick(t, range)) obad = true; }
    check('hijacked/OOD policy → envelope still holds', !obad);
  }
}

console.log(h(fails === 0
  ? `✅ flywheel verified — all ${reg.skills.length} skills (analytic · vla · lerobot) stay inside the one safety envelope`
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
