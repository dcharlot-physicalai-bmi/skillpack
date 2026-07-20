#!/usr/bin/env node
// skillpack — the open robot-skill CLI. Install skills as SOURCE you own (the shadcn mechanic), but
// with a twist only robots need: the install is CAPABILITY-GATED — it checks the skill against your
// robot's manifest and refuses (with reasons) if it won't run. Friction-zero adoption + a safety gate.
//
//   skillpack list                       browse the registry
//   skillpack init [--robot so101]       scaffold ./robot.json (your robot's capability manifest)
//   skillpack check <skill>              dry-run: will <skill> run on ./robot.json?
//   skillpack add <skill> [--force]      capability-gated install of <skill> into ./skills/<skill>/
//   skillpack new <name> [--morphology arm --dof 5 --policy analytic]   scaffold a skill you own
//   skillpack validate <dir>             schema + capability + the safety gate (hijacked policy stays bounded)
//   skillpack build-registry             regenerate registry.json from skills/ and robots/
//   skillpack verify                     run the skillpack self-test
//
// --registry <path|url>  point at a different registry (default: this package). --robot <file>  manifest.

import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { matchRobot, validateSkill } from '../skillcore.mjs';
import { packageDigest, fileDigests } from '../integrity.mjs';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));       // the skillpack package root
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[2m', gold: '\x1b[38;5;179m', x: '\x1b[0m' };
const c = (k, s) => `${C[k]}${s}${C.x}`;
const die = (m) => { console.error(c('r', '✗ ') + m); process.exit(1); };

// arg parsing
const [, , cmd, ...rest] = process.argv;
const flags = {}; const pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { const k = rest[i].slice(2); flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
  else pos.push(rest[i]);
}
const REG = flags.registry || PKG;
const isUrl = (s) => /^https?:\/\//.test(s);
async function readFrom(base, rel) {
  // a registry client should always see the current index, not a cached one
  if (isUrl(base)) { const r = await fetch(base.replace(/\/$/, '') + '/' + rel, { cache: 'no-store' }); if (!r.ok) throw new Error(`${r.status} ${rel}`); return r.text(); }
  return readFile(resolve(base, rel), 'utf8');
}
const loadRegistry = async () => JSON.parse(await readFrom(REG, 'registry.json'));

async function findRobot() {
  const cand = [flags.robot, './robot.json', './skillpack.robot.json'].filter(Boolean);
  for (const f of cand) if (existsSync(f)) return { file: f, robot: JSON.parse(await readFile(f, 'utf8')) };
  return null;
}

function printMatch(skill, robot) {
  const m = matchRobot(skill, robot);
  if (m.ok) console.log('  ' + c('g', '✓ compatible') + c('d', ` · ${robot.name || 'robot'}`));
  else { console.log('  ' + c('r', '✗ incompatible') + c('d', ` · ${robot.name || 'robot'}`)); m.reasons.forEach((r) => console.log('    ' + c('y', '· ') + r)); }
  return m.ok;
}

// ── commands ──
async function list() {
  const reg = await loadRegistry();
  console.log(c('b', `\n${reg.name}`) + c('d', ` v${reg.version}`) + `\n${c('d', reg.description)}\n`);
  console.log(c('gold', 'SKILLS'));
  for (const s of reg.skills) {
    const req = s.requires;
    console.log(`  ${c('b', s.name)}${c('d', ' @' + s.version)}  ${s.title}`);
    console.log(c('d', `    policy: ${s.policy} · needs: ${req.morphology} ≥${req.min_dof}dof ${req.actuation} · sensors ${(req.sensors || []).join(', ')}`));
  }
  console.log(c('gold', '\nROBOTS') + c('d', ' (sample manifests — skillpack init --robot <name>)'));
  for (const r of reg.robots) console.log(`  ${c('b', r.name)}  ${c('d', r.label)}`);
  console.log(c('d', `\n  skillpack add <skill>   ·   skillpack check <skill>\n`));
}

async function init() {
  if (existsSync('./robot.json') && !flags.force) die('./robot.json already exists (use --force to overwrite).');
  const reg = await loadRegistry();
  let robot;
  if (flags.robot && flags.robot !== true) {
    const entry = reg.robots.find((r) => r.name === flags.robot);
    if (!entry) die(`no sample robot "${flags.robot}". Try: ${reg.robots.map((r) => r.name).join(', ')}`);
    robot = JSON.parse(await readFrom(REG, entry.path));
  } else {
    robot = { name: 'my-robot', morphology: 'arm', dof: 5, actuation: 'position', sensors: ['proprioception', 'target_pose'], control_rate_hz: 20, driver: { target: 'feetech' } };
  }
  await writeFile('./robot.json', JSON.stringify(robot, null, 2) + '\n');
  console.log(c('g', '✓ ') + `wrote ./robot.json` + c('d', ` (${robot.name} · ${robot.morphology} ${robot.dof}-DoF · driver ${robot.driver?.target})`));
  console.log(c('d', '  edit it to describe your robot, then: skillpack add <skill>'));
}

async function check() {
  const name = pos[0]; if (!name) die('usage: skillpack check <skill>');
  const reg = await loadRegistry();
  const s = reg.skills.find((x) => x.name === name); if (!s) die(`no skill "${name}" in the registry.`);
  console.log(c('b', `\n${s.name}`) + `  ${s.title}`);
  const rb = await findRobot();
  if (!rb) die('no ./robot.json — run `skillpack init --robot so101` first (or pass --robot <file>).');
  console.log(c('d', `  vs ${rb.file}`));
  printMatch(s, rb.robot);
  console.log();
}

async function add() {
  const name = pos[0]; if (!name) die('usage: skillpack add <skill>');
  const reg = await loadRegistry();
  const s = reg.skills.find((x) => x.name === name); if (!s) die(`no skill "${name}" in the registry.`);
  console.log(c('b', `\nadd ${s.name}`) + c('d', ` @${s.version}`) + `  ${s.title}`);

  // capability gate — the robot-specific twist on shadcn's install
  const rb = await findRobot();
  if (rb) {
    const ok = printMatch(s, rb.robot);
    if (!ok && !flags.force) die('refusing to install a skill this robot cannot run (use --force to override, at your own risk).');
  } else {
    console.log(c('y', '  ! no ./robot.json — installing without a capability check (run `skillpack init`).'));
  }

  // fetch every file, then verify content integrity BEFORE writing anything to disk — a tampered manifest
  // (loosened safety caps) or a swapped policy is exactly what the runtime envelope can't catch, so we
  // check the bytes match what the author published before this source is ever run on a robot.
  const fetched = [];
  for (const f of s.files) fetched.push({ path: f, bytes: await readFrom(REG, join(s.path, f)) });
  if (s.integrity) {
    const got = packageDigest(fetched);
    if (got !== s.integrity) {
      if (!flags.insecure) die(`INTEGRITY CHECK FAILED — fetched bytes do not match the registry digest.\n    expected ${s.integrity}\n    got      ${got}\n  This skill may be tampered with. Refusing to install (override with --insecure at your own risk).`);
      console.log(c('y', '  ! --insecure: integrity mismatch ignored (NOT SAFE).'));
    } else {
      console.log('  ' + c('g', '✓ ') + c('d', `integrity verified — ${s.integrity.slice(0, 19)}…`));
    }
  } else {
    console.log(c('y', '  ! registry has no integrity digest for this skill — cannot verify provenance.'));
  }

  // install-as-source
  const dest = resolve('./skills', s.name);
  await mkdir(dest, { recursive: true });
  for (const { path: f, bytes: body } of fetched) {
    if (f === 'skill.json') { try { validateSkill(JSON.parse(body)); } catch (e) { die(`invalid ${f}: ${e.message}`); } }
    await writeFile(join(dest, f), body);
    console.log('  ' + c('g', '+ ') + c('d', `skills/${s.name}/`) + f);
  }
  console.log(c('g', `\n✓ installed `) + `skills/${s.name}/` + c('d', ` — source you own. Edit it freely.`));
  console.log(c('d', `  policy: ${s.policy}${s.policy === 'vla' ? ' (SmolVLA weights load in-browser on WebGPU)' : ''}\n`));
}

// ── author side: scaffold a new skill you own ──
function policyTemplate(velocity) {
  return velocity
    ? `// analytic velocity policy — proposes velocity toward the goal; the runtime bounds speed + accel.\nexport function create(skill, robot) {\n  const dof = robot.dof, K = 3.0;\n  return { reset() {}, step(obs) {\n    const p = obs.pose || obs.q || new Array(dof).fill(0), g = obs.goal || obs.q_target || new Array(dof).fill(0);\n    return Array.from({ length: dof }, (_, i) => K * ((g[i] ?? 0) - (p[i] ?? 0)));\n  } };\n}\n`
    : `// analytic policy — proposes the target config; the runtime ramps it under the velocity cap.\nexport function create(skill, robot) {\n  const dof = robot.dof;\n  return { reset() {}, step(obs) { const qt = obs.q_target; return Array.from({ length: dof }, (_, i) => qt[i]); } };\n}\n`;
}
function evalTemplate(dof, velocity) {
  const rnd = (i) => +(0.2 + 0.5 * ((i * 37) % 100) / 100).toFixed(2);
  const ep = (o) => ({ q0: Array.from({ length: dof }, (_, i) => 0.5), q_target: Array.from({ length: dof }, (_, i) => rnd(i + o)) });
  return { note: 'TODO: reproducible episodes for this skill.', tolerance: 0.03, max_ticks: velocity ? 120 : 80, dof, episodes: [ep(1), ep(4), ep(7)] };
}

async function newSkill() {
  const name = pos[0]; if (!name) die('usage: skillpack new <name> [--morphology arm --dof 5 --policy analytic]');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) die('skill name must be kebab-case (a-z, 0-9, -)');
  const dir = resolve('./skills', name);
  if (existsSync(dir) && !flags.force) die(`skills/${name}/ already exists (use --force).`);
  const morphology = flags.morphology || 'arm';
  const dof = +(flags.dof || (morphology === 'mobile' ? 2 : 5));
  const actuation = flags.actuation || (morphology === 'mobile' ? 'velocity' : 'position');
  const velocity = actuation === 'velocity';
  const kind = flags.policy || 'analytic';
  const policy = kind === 'lerobot'
    ? { kind: 'lerobot', ref: '../../policies/lerobot.mjs', checkpoint: 'hf://lerobot/TODO', observation: ['images', 'state'], action: 'q_cmd' }
    : { kind, ref: kind === 'analytic' ? './policy.mjs' : './policy.mjs', observation: velocity ? ['pose', 'goal'] : ['q', 'q_target'], action: velocity ? 'velocity' : 'q_cmd' };
  const skill = {
    name, version: '0.1.0', title: `TODO: what ${name} does`, summary: 'TODO: one line.',
    task: 'TODO', authors: ['TODO'], license: 'CC-BY-4.0', policy,
    requires: { morphology, min_dof: dof, actuation, sensors: velocity ? ['odometry'] : ['proprioception', 'target_pose'], control_rate_hz: 20 },
    safety: velocity ? { max_speed_norm: 0.6, max_accel_norm: 0.15, estop: 'zero-velocity', watchdog_ms: 200 }
                     : { max_step_norm: 0.08, clamp: [0, 1], estop: 'zero-velocity-hold', watchdog_ms: 250 },
    io: { action_space: velocity ? 'normalized-velocity' : 'normalized-joint-position-0..1', action_dim: 'robot.dof' },
    contract: { pre: ['TODO'], post: ['reaches the goal within tolerance', 'no per-tick step exceeded the cap'], invariants: ['every command within range', 'no NaN reaches the driver'] },
    eval: { ref: './eval.json', metric: 'success_rate', threshold: 0.8 },
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'skill.json'), JSON.stringify(skill, null, 2) + '\n');
  if (kind === 'analytic') await writeFile(join(dir, 'policy.mjs'), policyTemplate(velocity));
  await writeFile(join(dir, 'eval.json'), JSON.stringify(evalTemplate(dof, velocity), null, 2) + '\n');
  console.log(c('g', '✓ ') + `scaffolded ` + c('b', `skills/${name}/`) + c('d', ` (${morphology} · ${dof}-DoF · ${actuation} · ${kind})`));
  console.log(c('d', `  fill in the TODOs, then: skillpack validate ./skills/${name}\n`));
}

// ── validate a candidate skill: schema, capability sanity, and THE safety gate ──
async function validate() {
  const dir = pos[0]; if (!dir) die('usage: skillpack validate <skill-dir>');
  const { loadSkill, bind } = await import('../skillkit.mjs');
  let skill; try { skill = await loadSkill(resolve(dir)); } catch (e) { die(`invalid: ${e.message}`); }
  const m = skill.manifest;
  console.log(c('b', `\nvalidate ${m.name}@${m.version}`));
  console.log('  ' + c('g', '✓ ') + 'manifest valid — required fields + a well-formed safety envelope');
  const reg = await loadRegistry();
  const robots = []; for (const r of reg.robots) robots.push(JSON.parse(await readFrom(REG, r.path)));
  const compatible = robots.filter((rb) => matchRobot(m, rb).ok);
  if (compatible.length) console.log('  ' + c('g', '✓ ') + `runs on: ${compatible.map((r) => r.name).join(', ')}`);
  else console.log('  ' + c('y', '! ') + 'no sample robot satisfies requires{} — double-check morphology/dof/sensors');
  const robot = compatible[0];
  if (robot) {
    const velocity = m.requires.actuation === 'velocity';
    const [lo, hi] = velocity ? [-m.safety.max_speed_norm, m.safety.max_speed_norm] : [0, 1];
    const evil = { ...skill, policyMod: { create: () => ({ step: () => Array.from({ length: robot.dof }, (_, i) => [NaN, 9, -5, Infinity, 42][i % 5]) }) } };
    const rt = await bind(evil, robot, {});
    let bad = false;
    for (let k = 0; k < 30; k++) { const t = rt.step({}); if (!(t.wire && t.wire.data && t.wire.data.length) || t.q.some((v) => v < lo - 1e-9 || v > hi + 1e-9 || !Number.isFinite(v))) bad = true; }
    if (bad) die('SAFETY GATE FAILED — a hijacked policy escaped the envelope. Not safe to publish.');
    console.log('  ' + c('g', '✓ ') + 'safety envelope holds against a hijacked policy (bounded, valid wire)');
  }
  console.log(c('g', '\n✓ valid') + c('d', ' — run `skillpack build-registry`, then open a PR.\n'));
}

// ── maintainer side: regenerate registry.json from the skills/ and robots/ dirs ──
async function buildRegistry() {
  if (isUrl(REG)) die('build-registry works on a local registry directory, not a URL.');
  const base = resolve(REG);
  const skills = [];
  for (const name of (await readdir(join(base, 'skills'))).sort()) {
    const sdir = join(base, 'skills', name);
    if (!existsSync(join(sdir, 'skill.json'))) continue;
    const m = JSON.parse(await readFile(join(sdir, 'skill.json'), 'utf8'));
    const files = (await readdir(sdir)).filter((f) => /\.(json|mjs)$/.test(f)).sort();
    const r = m.requires;
    // content provenance: hash the exact bytes of every packaged file, so `skillpack add` can verify it
    const bytes = [];
    for (const f of files) bytes.push({ path: f, bytes: await readFile(join(sdir, f), 'utf8') });
    const entry = { name: m.name, title: m.title, version: m.version, path: `skills/${name}`, files, policy: m.policy.kind,
      requires: { morphology: r.morphology, min_dof: r.min_dof, actuation: r.actuation, sensors: r.sensors }, summary: m.summary,
      integrity: packageDigest(bytes), digests: fileDigests(bytes) };
    if (m.policy.checkpoint) entry.checkpoint = m.policy.checkpoint;
    if (m.policy.kind === 'lerobot') entry.runtime = '@skillpack/lerobot (shared adapter)';
    skills.push(entry);
  }
  const robots = [];
  for (const f of (await readdir(join(base, 'robots'))).sort()) if (f.endsWith('.json')) {
    const r = JSON.parse(await readFile(join(base, 'robots', f), 'utf8'));
    robots.push({ name: f.replace(/\.json$/, ''), path: `robots/${f}`, label: r.name });
  }
  const prev = existsSync(join(base, 'registry.json')) ? JSON.parse(await readFile(join(base, 'registry.json'), 'utf8')) : {};
  const reg = { $schema: prev.$schema, name: prev.name || 'skillpack-registry', version: prev.version || '0.2.0',
    homepage: prev.homepage, description: prev.description, skills, robots };
  await writeFile(join(base, 'registry.json'), JSON.stringify(reg, null, 2) + '\n');
  console.log(c('g', '✓ ') + `built registry.json` + c('d', ` — ${skills.length} skills, ${robots.length} robots`));
}

function verify() {
  const r = spawnSync('node', [resolve(PKG, 'verify.mjs')], { stdio: 'inherit' });
  process.exit(r.status || 0);
}

// Run the normative conformance battery. With a skill dir → certify that skill (skill + runtime levels)
// on a capability-matched sample robot. With no arg → run the full reference-implementation battery.
async function conformance() {
  const dir = pos[0];
  if (!dir) {
    const r = spawnSync('node', [resolve(PKG, 'verify-conformance.mjs'), ...(flags.report ? ['--report'] : [])], { stdio: 'inherit' });
    process.exit(r.status || 0);
  }
  const { loadSkill, bind } = await import('../skillkit.mjs');
  const { conformanceReport } = await import('../conformance/run.mjs');
  let skill; try { skill = await loadSkill(resolve(dir)); } catch (e) { die(`invalid: ${e.message}`); }
  const reg = await loadRegistry();
  const robots = []; for (const rr of reg.robots) robots.push(JSON.parse(await readFrom(REG, rr.path)));
  const robot = robots.find((rb) => matchRobot(skill.manifest, rb).ok);
  if (!robot) die('no sample robot satisfies requires{} — cannot run runtime conformance. Fix the manifest or pass a registry with a compatible robot.');
  const report = await conformanceReport({ skill, robot, core: { validateSkill, matchRobot }, runtime: { bind } });
  console.log(c('b', `\nconformance ${skill.manifest.name}@${skill.manifest.version}`) + c('d', ` · runtime robot: ${robot.name}`));
  for (const r of report.results) {
    const mark = r.status === 'pass' ? c('g', '✓') : r.status === 'n/a' ? c('d', '○') : c('y', '✗');
    console.log(`  ${mark} ${c('d', r.level === 'skill' ? '[skill]  ' : '[runtime]')} ${r.id}  ${c('d', r.detail)}`);
  }
  const { pass, fail, 'n/a': na } = report.counts;
  console.log(report.conformant
    ? c('g', `\n✓ CONFORMANT`) + c('d', ` — ${pass} passed, ${na} n/a. This skill meets the skillpack standard.\n`)
    : c('y', `\n✗ NOT CONFORMANT`) + ` — ${fail} requirement(s) failed.\n`);
  process.exit(report.conformant ? 0 : 1);
}

const CMDS = { list, init, check, add, verify, conformance, new: newSkill, validate, 'build-registry': buildRegistry };
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`${c('b', 'skillpack')} — the open robot-skill CLI\n
${c('d', 'use a skill')}
  ${c('gold', 'list')}                    browse the registry
  ${c('gold', 'init')} [--robot so101]    scaffold ./robot.json (your capability manifest)
  ${c('gold', 'check')} <skill>           will <skill> run on ./robot.json?
  ${c('gold', 'add')} <skill> [--force]   capability-gated install of <skill> as source
${c('d', 'author a skill')}
  ${c('gold', 'new')} <name> [--morphology arm --dof 5 --policy analytic]   scaffold a skill you own
  ${c('gold', 'validate')} <dir>          schema + capability + the safety gate (hijacked policy stays bounded)
  ${c('gold', 'conformance')} [dir]       run the normative standard: [dir] certifies one skill, no-arg = full battery
  ${c('gold', 'build-registry')}          regenerate registry.json from skills/ and robots/
  ${c('gold', 'verify')}                  run the skillpack self-test
${c('d', '\n  --registry <path|url>   --robot <file>')}`);
  process.exit(0);
}
if (!CMDS[cmd]) die(`unknown command "${cmd}". Try: skillpack help`);
CMDS[cmd]().catch((e) => die(e.message));
