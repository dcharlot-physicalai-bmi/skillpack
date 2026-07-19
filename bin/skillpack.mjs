#!/usr/bin/env node
// skillpack — the open robot-skill CLI. Install skills as SOURCE you own (the shadcn mechanic), but
// with a twist only robots need: the install is CAPABILITY-GATED — it checks the skill against your
// robot's manifest and refuses (with reasons) if it won't run. Friction-zero adoption + a safety gate.
//
//   skillpack list                       browse the registry
//   skillpack init [--robot so101]       scaffold ./robot.json (your robot's capability manifest)
//   skillpack check <skill>              dry-run: will <skill> run on ./robot.json?
//   skillpack add <skill> [--force]      capability-gated install of <skill> into ./skills/<skill>/
//   skillpack verify                     run the skillpack self-test
//
// --registry <path|url>  point at a different registry (default: this package). --robot <file>  manifest.

import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { matchRobot, validateSkill } from '../skillcore.mjs';

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
  if (isUrl(base)) { const r = await fetch(base.replace(/\/$/, '') + '/' + rel); if (!r.ok) throw new Error(`${r.status} ${rel}`); return r.text(); }
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

  // install-as-source
  const dest = resolve('./skills', s.name);
  await mkdir(dest, { recursive: true });
  for (const f of s.files) {
    const body = await readFrom(REG, join(s.path, f));
    if (f === 'skill.json') { try { validateSkill(JSON.parse(body)); } catch (e) { die(`invalid ${f}: ${e.message}`); } }
    await writeFile(join(dest, f), body);
    console.log('  ' + c('g', '+ ') + c('d', `skills/${s.name}/`) + f);
  }
  console.log(c('g', `\n✓ installed `) + `skills/${s.name}/` + c('d', ` — source you own. Edit it freely.`));
  console.log(c('d', `  policy: ${s.policy}${s.policy === 'vla' ? ' (SmolVLA weights load in-browser on WebGPU)' : ''}\n`));
}

function verify() {
  const r = spawnSync('node', [resolve(PKG, 'verify.mjs')], { stdio: 'inherit' });
  process.exit(r.status || 0);
}

const CMDS = { list, init, check, add, verify };
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`${c('b', 'skillpack')} — the open robot-skill CLI\n
  ${c('gold', 'list')}                    browse the registry
  ${c('gold', 'init')} [--robot so101]    scaffold ./robot.json (your capability manifest)
  ${c('gold', 'check')} <skill>           will <skill> run on ./robot.json?
  ${c('gold', 'add')} <skill> [--force]   capability-gated install of <skill> as source
  ${c('gold', 'verify')}                  run the skillpack self-test
${c('d', '\n  --registry <path|url>   --robot <file>')}`);
  process.exit(0);
}
if (!CMDS[cmd]) die(`unknown command "${cmd}". Try: skillpack help`);
CMDS[cmd]().catch((e) => die(e.message));
