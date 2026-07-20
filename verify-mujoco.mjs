// verify-mujoco.mjs — physics-in-the-loop eval. A skill's safety-bounded commands drive a REAL MuJoCo
// rigid-body arm (gravity, inertia, joint coupling), and success is measured on the physical joint state —
// not a kinematic approximation. Proves the contract + envelope hold against actual dynamics.
// Auto-skips if the mujoco venv isn't present.
//   node verify-mujoco.mjs            (npm run test:mujoco)

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, bind } from './skillkit.mjs';
import { safetyClamp } from './skillcore.mjs';
import { connectMuJoCo } from './bridge/mujoco-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENV_PY = process.env.VENV_PY || join(HERE, '.venv-lerobot/bin/python');
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;
const maxErr = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

if (!existsSync(VENV_PY)) {
  console.log(h('verify-mujoco — SKIPPED'));
  console.log(`  ⚪ no venv at ${VENV_PY} (npm run setup:lerobot installs mujoco). Kinematic eval is covered by verify-eval.mjs.`);
  process.exit(0);
}

const robot = JSON.parse(await readFile(join(HERE, 'robots/so101.json'), 'utf8'));
const skill = await loadSkill(join(HERE, 'skills/arm-reach'));
const dof = robot.dof, maxStep = skill.manifest.safety.max_step_norm, tol = 0.05, maxTicks = 120;
const TARGETS = [
  [0.65, 0.42, 0.55, 0.46, 0.58], [0.40, 0.60, 0.48, 0.55, 0.50],
  [0.60, 0.45, 0.62, 0.40, 0.55], [0.50, 0.55, 0.45, 0.58, 0.48],
];

console.log(h('physics-in-the-loop · a real MuJoCo arm driven through the safety envelope'));
let link;
try {
  link = connectMuJoCo({ python: VENV_PY });
  const readied = await Promise.race([link.ready().then(() => true), new Promise((r) => setTimeout(r, 30000))]);
  if (!readied || !String(link.mode()).startsWith('mujoco')) {
    console.log(`  ⚪ SKIPPED — mujoco not available (mode=${link.mode()}); pip install mujoco in the venv.`);
    if (link) await link.close();
    process.exit(0);
  }
  check('MuJoCo physics arm loaded', String(link.mode()).startsWith('mujoco'), link.mode());

  let reached = 0, worstStep = 0, allBounded = true, allFinite = true;
  for (const target of TARGETS) {
    const rt = await bind(skill, robot, { q0: new Array(dof).fill(0.5) });
    let phys = (await link.reset(new Array(dof).fill(0.5))).qpos;
    let prev = phys.slice();
    for (let k = 0; k < maxTicks; k++) {
      const t = rt.step({ q: phys, q_target: target, state: phys });     // obs = PHYSICAL joint state
      for (let i = 0; i < dof; i++) { worstStep = Math.max(worstStep, Math.abs(t.q[i] - prev[i])); if (t.q[i] < 0 || t.q[i] > 1) allBounded = false; }
      prev = t.q;
      phys = (await link.step(t.q)).qpos;                                // physics steps under the command
      if (phys.some((v) => !Number.isFinite(v))) allFinite = false;
      if (maxErr(phys, target) < tol) { reached++; break; }
    }
  }
  check('the physical arm reaches its targets under real dynamics', reached >= 3, `${reached}/${TARGETS.length} reached (gravity + inertia + coupling)`);
  check('every command stayed within the velocity cap', worstStep <= maxStep + 1e-9, `max step ${worstStep.toFixed(3)} ≤ ${maxStep}`);
  check('every command stayed in [0,1]', allBounded);
  check('the physics stayed finite (no blow-up)', allFinite);

  console.log(h('a hijacked policy cannot drive the physical arm out of bounds'));
  const evil = { ...skill, policyMod: { create: () => ({ step: () => [NaN, 9, -5, Infinity, 42] }) } };
  const rtE = await bind(evil, robot, { q0: new Array(dof).fill(0.5) });
  let phys = (await link.reset(new Array(dof).fill(0.5))).qpos, bad = false;
  for (let k = 0; k < 60; k++) {
    const t = rtE.step({ q: phys });
    if (t.q.some((v) => v < 0 || v > 1 || !Number.isFinite(v))) bad = true;
    phys = (await link.step(t.q)).qpos;
    if (phys.some((v) => !Number.isFinite(v) || v < -0.01 || v > 1.01)) bad = true;
  }
  check('60 ticks of garbage → commands + physical joints stay bounded', !bad);
} finally {
  if (link) await link.close();
}

console.log(h(fails === 0
  ? '✅ physics-verified — a real MuJoCo arm reaches under dynamics, bounded by the safety envelope'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
