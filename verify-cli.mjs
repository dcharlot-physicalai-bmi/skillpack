// verify-cli.mjs — the CLI end-to-end: list → init → check → add (capability-gated) in a temp project.
//   node v2/skillpack/verify-cli.mjs

import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, 'bin/skillpack.mjs');
let fails = 0;
const check = (name, cond, detail = '') => { console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
// run the CLI in `cwd`; registry points back at the package so no network needed.
const run = (args, cwd) => { const r = spawnSync('node', [CLI, ...args, '--registry', HERE], { cwd, encoding: 'utf8' }); return { out: strip((r.stdout || '') + (r.stderr || '')), code: r.status }; };

const proj = await mkdtemp(join(tmpdir(), 'skillpack-'));
console.log(h(`CLI end-to-end · temp project ${proj}`));

// 1 · list
console.log(h('1 · skillpack list'));
const l = run(['list'], proj);
check('lists arm-reach and arm-reach-vla', /arm-reach\b/.test(l.out) && /arm-reach-vla/.test(l.out));
check('shows the sample robots', /so101/.test(l.out) && /turtlebot/.test(l.out));

// 2 · init an arm robot (SO-101)
console.log(h('2 · skillpack init --robot so101'));
const i = run(['init', '--robot', 'so101'], proj);
check('wrote ./robot.json', existsSync(join(proj, 'robot.json')));
const robot = JSON.parse(await readFile(join(proj, 'robot.json'), 'utf8'));
check('robot manifest is the SO-101 arm', robot.morphology === 'arm' && robot.driver.target === 'feetech');

// 3 · check compatibility (arm skill on the arm robot)
console.log(h('3 · skillpack check arm-reach'));
const ck = run(['check', 'arm-reach'], proj);
check('reports compatible', /compatible/.test(ck.out) && !/incompatible/.test(ck.out));

// 4 · add — capability-gated install
console.log(h('4 · skillpack add arm-reach (capability-gated install-as-source)'));
const a = run(['add', 'arm-reach'], proj);
check('install succeeded', a.code === 0 && /installed/.test(a.out));
check('source files landed in ./skills/arm-reach/', existsSync(join(proj, 'skills/arm-reach/skill.json')) && existsSync(join(proj, 'skills/arm-reach/policy.mjs')));
check('installed skill.json is valid + editable source', JSON.parse(await readFile(join(proj, 'skills/arm-reach/skill.json'), 'utf8')).name === 'arm-reach');

// 5 · the value-add over shadcn: install REFUSED on an incompatible robot
console.log(h('5 · capability gate — install refused when the robot cannot run the skill'));
const mobile = join(proj, 'mobile');
await mkdir(mobile, { recursive: true });
run(['init', '--robot', 'turtlebot'], mobile);
const refuse = run(['add', 'arm-reach'], mobile);
check('arm skill REFUSED on the TurtleBot, with reasons', refuse.code !== 0 && /incompatible|refusing/.test(refuse.out),
      (refuse.out.match(/morphology:[^\n]*/) || [''])[0].trim());
check('nothing was installed on the incompatible robot', !existsSync(join(mobile, 'skills/arm-reach')));
const forced = run(['add', 'arm-reach', '--force'], mobile);
check('--force overrides the gate (at your own risk)', forced.code === 0 && existsSync(join(mobile, 'skills/arm-reach')));

// 6 · VLA skill gating differs (needs a camera)
console.log(h('6 · skillpack add arm-reach-vla — needs a camera'));
const vlaOnArm = run(['add', 'arm-reach-vla'], proj);              // SO-101 has a camera → ok
check('VLA skill installs on SO-101 (has camera)', vlaOnArm.code === 0 && existsSync(join(proj, 'skills/arm-reach-vla/policy.smolvla.mjs')));
const maestro = join(proj, 'maestro');
await mkdir(maestro, { recursive: true });
run(['init', '--robot', 'maestro-arm'], maestro);
const vlaNoCam = run(['add', 'arm-reach-vla'], maestro);          // Maestro arm, no camera → refused
check('VLA skill REFUSED on the camera-less Maestro arm', vlaNoCam.code !== 0 && /camera/.test(vlaNoCam.out));

await rm(proj, { recursive: true, force: true });
console.log(h(fails === 0 ? '✅ CLI verified — list · init · check · capability-gated add · install-as-source' : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
