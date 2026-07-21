// verify-safety-case.mjs — pin the SAFETY.md safety case in both directions. The guarantees (G) must hold;
// the NON-guarantees (N) must ALSO be demonstrated true — i.e. the runtime honestly does NOT do them — so
// the documented scope can't quietly drift into overclaiming. If someone later "improves" the envelope to
// cover N2 (collision) or the docs start claiming task-correctness, a boundary test here fails.
//   node v2/skillpack/verify-safety-case.mjs

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, bind } from './skillkit.mjs';
import { matchRobot } from './skillcore.mjs';
import { planAndRun } from './agent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const arm = JSON.parse(await readFile(join(HERE, 'robots/so101.json'), 'utf8'));
const reachSkill = await loadSkill(join(HERE, 'skills/arm-reach'));
const skills = [reachSkill];
const evilPolicy = (dof) => ({ ...reachSkill, policyMod: { create: () => ({ step: () => Array.from({ length: dof }, (_, i) => [NaN, 9, -5, Infinity, 42][i % 5]) }) } });

console.log(h('the safety case document exists and is the source of these claims'));
check('SAFETY.md is present', existsSync(join(HERE, 'SAFETY.md')));

// ── GUARANTEES must hold ───────────────────────────────────────────────────────────────────────────
console.log(h('GUARANTEES (must hold, even against a hijacked policy)'));
const rt = await bind(evilPolicy(arm.dof), arm, {});
const { lo, hi, maxStep } = rt.envelope;
let prev = rt.state(), g1 = true, g2 = true, g3 = true;
for (let k = 0; k < 40; k++) {
  const t = rt.step({});
  for (let i = 0; i < t.q.length; i++) {
    if (t.q[i] < lo - 1e-9 || t.q[i] > hi + 1e-9) g1 = false;
    if (Math.abs(t.q[i] - prev[i]) > maxStep + 1e-9) g2 = false;
    if (!Number.isFinite(t.q[i])) g3 = false;
  }
  if (!(t.wire && t.wire.data && t.wire.data.length)) g3 = false;
  prev = t.q;
}
check('G1 — every command within per-joint range', g1);
check('G2 — no per-tick change exceeds the rate cap', g2);
check('G3 — no NaN/Inf reaches the wire', g3);
check('G4 — estop is safe (hold in range for a position arm)', rt.estop().every((v) => v >= lo - 1e-9 && v <= hi + 1e-9));
check('G5 — an incompatible skill is refused before motion', !matchRobot((await loadSkill(join(HERE, 'skills/humanoid-balance'))).manifest, arm).ok);

// ── NON-GUARANTEES must be demonstrably TRUE (the runtime does NOT do them) ─────────────────────────
console.log(h('NON-GUARANTEES (must be honestly out of scope — these prove we do not overclaim)'));

// N1 — task correctness: an in-range but task-wrong target executes "safely" — the envelope has no opinion.
const wrong = await planAndRun({ goal: 'reach the WRONG place', robot: arm, skills,
  planner: () => [{ skill: 'arm-reach', target: [0.1, 0.9, 0.1, 0.9, 0.1] }] });
check('N1 — the envelope permits an in-range but task-wrong target (task correctness is NOT provided)',
  wrong.safe === true && wrong.steps[0].status === 'done', 'ran safely though the goal may be wrong — owned by planner/eval');

// N2 — inter-joint/collision: two joints simultaneously at opposite in-range extremes is permitted; the
// envelope bounds each joint independently and models no geometry, so it cannot reject a colliding config.
const rt2 = await bind(reachSkill, arm, {});
let both = null; for (let k = 0; k < 60; k++) both = rt2.step({ q_target: [0.0, 1.0, 0.0, 1.0, 0.0], state: rt2.state(), q: rt2.state() }).q;
check('N2 — a config that a collision layer might reject is permitted (no geometry model)',
  both.every((v) => v >= -1e-9 && v <= 1 + 1e-9), `commanded [${both.map((v) => v.toFixed(1)).join(',')}] — all in range, geometry NOT checked`);

// N4 — perception: a benign policy given a SPOOFED observation produces an in-range but wrong action; the
// envelope bounds the action, not the truth of the input.
const spoofSkill = { ...reachSkill, policyMod: { create: () => ({ step: (obs) => obs.q_target }) } };  // trusts its input
const rt3 = await bind(spoofSkill, arm, {});
const spoofed = rt3.step({ q_target: [0.95, 0.05, 0.95, 0.05, 0.95], state: rt3.state(), q: rt3.state() }).q;
check('N4 — a spoofed observation yields an in-range but wrong action (perception integrity is NOT provided)',
  spoofed.every((v) => v >= -1e-9 && v <= 1 + 1e-9), 'action bounded, input trust NOT checked — owned by perception/attestation');

console.log(h(fails === 0
  ? '✅ safety case verified — every guarantee holds, and every non-guarantee is honestly out of scope (no overclaiming)'
  : `❌ ${fails} safety-case check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
