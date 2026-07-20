// verify-torque.mjs — the third actuation type. A TORQUE/impedance skill gates onto a torque-controlled
// arm (off position arms), and the safety envelope becomes a FORCE limit: commanded torque is bounded in
// magnitude and rate. On a joint mass-damper sim the compliant controller converges toward the target
// without ever exceeding the force limit, and a hijacked policy can't apply an unsafe torque.
//   node v2/skillpack/verify-torque.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, matchRobot, bind } from './skillkit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const robot = async (f) => JSON.parse(await readFile(resolve(HERE, 'robots', f), 'utf8'));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const skill = await loadSkill(join(HERE, 'skills/arm-compliant-push'));
const m = skill.manifest;
const torqueArm = await robot('torque-arm.json');
const so101 = await robot('so101.json');       // position-controlled arm
const dof = torqueArm.dof, tauMax = m.safety.max_torque_norm, rateMax = m.safety.max_torque_rate_norm;

console.log(h('1 · Capability negotiation on the action space'));
check('compliant-push RUNS on the torque-controlled arm', matchRobot(m, torqueArm).ok);
const onPos = matchRobot(m, so101);
check('refused on a POSITION-controlled arm (wrong actuation)', !onPos.ok, onPos.reasons.find((r) => /actuation/.test(r)));

console.log(h('2 · The runtime is in torque mode — a symmetric force envelope'));
const rt = await bind(skill, torqueArm, {});
check('runtime reports torque + symmetric', rt.torque === true && rt.symmetric === true);
check('starts from zero torque', rt.state().every((v) => v === 0));
check('estop is zero torque', rt.estop().every((v) => v === 0));
check('envelope is the force limit [-τmax, τmax]', Math.abs(rt.envelope.lo + tauMax) < 1e-9 && Math.abs(rt.envelope.hi - tauMax) < 1e-9);

console.log(h('3 · Compliant convergence — torque-limited spring-damper reaches the target'));
// joint mass-damper world: q̈ = τ − b·q̇ (unit mass). The bounded impedance torque drives q → target.
function reach(target, ticks = 200, dt = 0.02, b = 0.6) {
  let q = new Array(dof).fill(0.5), qd = new Array(dof).fill(0), prevTau = rt.state(), maxTau = 0, maxRate = 0;
  const rt2 = rt;
  for (let k = 0; k < ticks; k++) {
    const t = rt2.step({ q, q_target: target, q_dot: qd });     // t.q = bounded TORQUE
    for (let i = 0; i < dof; i++) { maxTau = Math.max(maxTau, Math.abs(t.q[i])); maxRate = Math.max(maxRate, Math.abs(t.q[i] - prevTau[i])); }
    prevTau = t.q;
    for (let i = 0; i < dof; i++) { const qdd = t.q[i] - b * qd[i]; qd[i] += qdd * dt; q[i] = Math.max(0, Math.min(1, q[i] + qd[i] * dt)); }
  }
  return { q, err: Math.max(...q.map((v, i) => Math.abs(v - target[i]))), maxTau, maxRate };
}
const r = reach([0.6, 0.42, 0.55, 0.46, 0.5]);
check('the arm converges toward the target compliantly', r.err < 0.05, `final error ${r.err.toFixed(3)}`);
check('commanded torque never exceeded the force limit', r.maxTau <= tauMax + 1e-9, `max |τ| ${r.maxTau.toFixed(3)} ≤ ${tauMax}`);
check('torque rate stayed within the cap', r.maxRate <= rateMax + 1e-9, `max |Δτ| ${r.maxRate.toFixed(3)} ≤ ${rateMax}`);

console.log(h('4 · Directionally correct impedance (torque pulls toward the target)'));
const rt3 = await bind(skill, torqueArm, {});
const push = rt3.step({ q: [0.3, 0.7, 0.5, 0.5, 0.5], q_target: [0.6, 0.4, 0.5, 0.5, 0.5], q_dot: new Array(dof).fill(0) });
check('below target → positive torque; above → negative (a spring)', push.proposed[0] > 0 && push.proposed[1] < 0,
      `τ0 ${push.proposed[0].toFixed(2)} (q<qt), τ1 ${push.proposed[1].toFixed(2)} (q>qt)`);

console.log(h('5 · A hijacked policy cannot apply an unsafe force'));
const evil = { ...skill, policyMod: { create: () => ({ step: () => [NaN, 9, -5, Infinity, 42] }) } };
const rtE = await bind(evil, torqueArm, {});
let bad = false;
for (let k = 0; k < 40; k++) { const t = rtE.step({}); if (!(t.wire && t.wire.data && t.wire.data.length) || t.q.some((v) => Math.abs(v) > tauMax + 1e-9 || !Number.isFinite(v))) bad = true; }
check('garbage torques bounded to the force limit + valid wire', !bad);

console.log(h(fails === 0
  ? '✅ torque action space verified — compliant impedance control, bounded by a force envelope'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
