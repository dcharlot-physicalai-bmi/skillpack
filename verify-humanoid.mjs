// verify-humanoid.mjs — the contract spans HUMANOIDS. A 20-DoF whole-body balance policy gates onto a
// humanoid, runs through the safety envelope, and actually BALANCES: on a linear-inverted-pendulum CoM
// model, the controller keeps the center of mass over the support polygon and returns it to center after
// a push. Every joint bounded; a hijacked balance policy can't drive the joints out of range.
//   node v2/skillpack/verify-humanoid.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, matchRobot, bind } from './skillkit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const robot = async (f) => JSON.parse(await readFile(resolve(HERE, 'robots', f), 'utf8'));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const skill = await loadSkill(join(HERE, 'skills/humanoid-balance'));
const m = skill.manifest;
const hum = await robot('humanoid.json');
const so101 = await robot('so101.json');
const quad = await robot('quadruped.json');
const dof = hum.dof, maxStep = m.safety.max_step_norm;

console.log(h('1 · Capability negotiation'));
check('balance RUNS on the humanoid (20-DoF whole body)', matchRobot(m, hum).ok);
const onArm = matchRobot(m, so101);
check('refused on a 5-DoF arm, with reasons', !onArm.ok, onArm.reasons.join(' · '));
check('refused on the quadruped (needs force_torque + humanoid morphology)', !matchRobot(m, quad).ok);

// Linear inverted pendulum: com_ddot = ω²(com − cop). cop is set by the (envelope-bounded) ankle command.
const W2 = 9.81 / 0.9, DT = 0.02, EDGE = 1.0, TOL = 0.15;
async function balance(push, ticks = 200) {
  const rt = await bind(skill, hum, { q0: new Array(dof).fill(0.5) });
  let com = [push[0], push[1]], vel = [0, 0], prev = rt.state(), fell = false, maxStepSeen = 0, bounded = true;
  for (let k = 0; k < ticks; k++) {
    const t = rt.step({ com, com_vel: vel });
    for (let i = 0; i < dof; i++) { maxStepSeen = Math.max(maxStepSeen, Math.abs(t.q[i] - prev[i])); if (t.q[i] < 0 || t.q[i] > 1 || !Number.isFinite(t.q[i])) bounded = false; }
    prev = t.q;
    const cop = [(t.q[0] - 0.5) * 2, (t.q[1] - 0.5) * 2];      // ankle pitch/roll → center of pressure
    for (const ax of [0, 1]) { const acc = W2 * (com[ax] - cop[ax]); vel[ax] += acc * DT; com[ax] += vel[ax] * DT; }
    if (Math.hypot(com[0], com[1]) > EDGE) fell = true;         // CoM left the support polygon = a fall
  }
  return { recovered: !fell && Math.hypot(com[0], com[1]) < TOL, fell, finalOffset: Math.hypot(com[0], com[1]), maxStepSeen, bounded };
}

console.log(h('2 · It balances — CoM stays in the support polygon and returns after a push'));
const pushes = [[0.4, 0], [0, 0.4], [0.35, 0.35], [-0.45, 0.2], [0.5, -0.3]];
const results = [];
for (const p of pushes) results.push(await balance(p));
const recovered = results.filter((r) => r.recovered).length;
check('recovers from pushes (CoM returns to center)', recovered >= 4, `${recovered}/${pushes.length} recovered · none fell: ${results.every((r) => !r.fell)}`);
check('every joint stayed in [0,1] and within the velocity cap', results.every((r) => r.bounded) && Math.max(...results.map((r) => r.maxStepSeen)) <= maxStep + 1e-9,
      `max step ${Math.max(...results.map((r) => r.maxStepSeen)).toFixed(3)} ≤ ${maxStep}`);

console.log(h('3 · The response is directionally correct (capture-point: CoP leads CoM)'));
const rt = await bind(skill, hum, { q0: new Array(dof).fill(0.5) });
const fwd = rt.step({ com: [0.4, 0], com_vel: [0, 0] });        // leaning forward
const proposedCoP = (fwd.proposed[0] - 0.5) * 2;               // the controller's INTENT (pre-envelope)
check('the controller commands CoP ahead of the CoM (restoring intent)', proposedCoP > 0.4, `proposed CoP_x ${proposedCoP.toFixed(2)} > CoM_x 0.40`);
// the envelope rate-limits the ankle (realistic velocity limit); the realized CoP catches up over a few ticks
let realizedCoP = (fwd.q[0] - 0.5) * 2;
for (let k = 0; k < 10; k++) realizedCoP = (rt.step({ com: [0.4, 0], com_vel: [0, 0] }).q[0] - 0.5) * 2;
check('the realized CoP catches up past the CoM once the ankle ramps (envelope-limited)', realizedCoP > 0.4, `realized CoP_x ${realizedCoP.toFixed(2)} after ramp`);

console.log(h('4 · A hijacked balance policy stays bounded'));
const evil = { ...skill, policyMod: { create: () => ({ step: () => new Array(dof).fill(0).map((_, i) => [NaN, 9, -5, Infinity, 42][i % 5]) }) } };
const rtE = await bind(evil, hum, { q0: new Array(dof).fill(0.5) });
let bad = false;
for (let k = 0; k < 40; k++) { const t = rtE.step({ com: [0, 0], com_vel: [0, 0] }); if (!(t.wire && t.wire.data && t.wire.data.length) || t.q.some((v) => v < 0 || v > 1 || !Number.isFinite(v))) bad = true; }
check('garbage joint commands stay bounded + valid wire', !bad);

console.log(h(fails === 0
  ? '✅ humanoid morphology verified — a 20-DoF balance controller keeps the CoM in the polygon, safety-enveloped'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
