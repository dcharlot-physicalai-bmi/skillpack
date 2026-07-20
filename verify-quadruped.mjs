// verify-quadruped.mjs — the contract spans LEGGED robots. A 12-DoF CPG trot gates onto a quadruped
// (off the arms and the mobile base), flows through the same safety envelope, and produces a real periodic,
// phase-correct gait — diagonal leg pairs synchronized, adjacent legs in antiphase — every joint bounded.
//   node v2/skillpack/verify-quadruped.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, matchRobot, bind } from './skillkit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const robot = async (f) => JSON.parse(await readFile(resolve(HERE, 'robots', f), 'utf8'));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;
const range = (a) => Math.max(...a) - Math.min(...a);
function corr(a, b) {
  const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  return cov / (Math.sqrt(va * vb) || 1e-9);
}
function feetechish(wire) { return wire && wire.data && wire.data.length > 0; }

const skill = await loadSkill(join(HERE, 'skills/quadruped-trot'));
const m = skill.manifest;
const quad = await robot('quadruped.json');
const so101 = await robot('so101.json');
const turtle = await robot('turtlebot.json');
const dof = quad.dof, maxStep = m.safety.max_step_norm;

console.log(h('1 · Capability negotiation across morphologies'));
check('trot gait RUNS on the quadruped (12-DoF legged)', matchRobot(m, quad).ok);
const onArm = matchRobot(m, so101);
check('refused on a 5-DoF arm, with reasons', !onArm.ok, onArm.reasons.join(' · '));
check('refused on the mobile base', !matchRobot(m, turtle).ok);

console.log(h('2 · The gait runs through the safety envelope'));
const rt = await bind(skill, quad, { q0: new Array(dof).fill(0.5) });
const cols = Array.from({ length: dof }, () => []);
let bad = false, maxSeen = 0, prev = rt.state();
for (let k = 0; k < 80; k++) {
  const t = rt.step({});
  for (let i = 0; i < dof; i++) { cols[i].push(t.q[i]); maxSeen = Math.max(maxSeen, Math.abs(t.q[i] - prev[i])); if (t.q[i] < 0 || t.q[i] > 1 || !Number.isFinite(t.q[i])) bad = true; }
  if (!feetechish(t.wire)) bad = true;
  prev = t.q;
}
check('every joint command valid wire + in [0,1] (80 ticks)', !bad);
check('no tick exceeded the velocity cap (gait tuned to flow through)', maxSeen <= maxStep + 1e-9, `max step ${maxSeen.toFixed(3)} ≤ ${maxStep}`);

console.log(h('3 · It is a real gait — rhythmic, and phase-correct'));
const s = (i) => cols[i].slice(15);                       // drop the start-up transient
const thighRanges = [1, 4, 7, 10].map((i) => range(s(i)));
check('the thigh joints actually oscillate (a gait, not a pose)', thighRanges.every((r) => r > 0.15), `thigh swings ~${thighRanges.map((r) => r.toFixed(2)).join(', ')}`);
check('hip-abduction joints stay roughly static', [0, 3, 6, 9].every((i) => range(s(i)) < 0.05));
// trot phase: FL(thigh 1) & RR(thigh 10) are a diagonal pair → in phase; FL(1) & FR(4) adjacent → antiphase
const diag = corr(s(1), s(10)), adj = corr(s(1), s(4));
check('diagonal legs are synchronized (corr > 0.9)', diag > 0.9, `corr(FL,RR)=${diag.toFixed(2)}`);
check('adjacent legs are in antiphase (corr < -0.9)', adj < -0.9, `corr(FL,FR)=${adj.toFixed(2)}`);

console.log(h('4 · A hijacked gait policy stays bounded'));
const evil = { ...skill, policyMod: { create: () => ({ step: () => new Array(dof).fill(0).map((_, i) => [NaN, 9, -5, Infinity, 42][i % 5]) }) } };
const rtE = await bind(evil, quad, { q0: new Array(dof).fill(0.5) });
let ebad = false;
for (let k = 0; k < 40; k++) { const t = rtE.step({}); if (!feetechish(t.wire) || t.q.some((v) => v < 0 || v > 1 || !Number.isFinite(v))) ebad = true; }
check('garbage joint commands stay bounded + valid wire', !ebad);

console.log(h(fails === 0
  ? '✅ legged morphology verified — a 12-DoF trot gait, gated + safety-enveloped, rhythmic and phase-correct'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
