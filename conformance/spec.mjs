// skillpack conformance — the NORMATIVE battery. These are the requirements an implementation MUST
// satisfy to call itself skillpack-conformant. They are the executable form of SPEC.md: each requirement
// carries its normative "MUST" text, the spec section it comes from, and a test that runs against a
// PLUGGABLE implementation — so a third party can certify THEIR runtime/skills, not just this repo's.
//
// Two levels:
//   • SKILL   conformance — a skill package declares a well-formed contract + safety envelope + eval,
//               and gates onto robots by capability.  Fixture: {skill, robot, core:{validateSkill, matchRobot}}.
//   • RUNTIME conformance — a runtime bounds ANY policy (including a hijacked one) inside the declared
//               envelope, and offers a safe estop/reset.  Fixture: adds runtime:{bind}.
//
// A requirement's test returns { pass, detail }. Throwing counts as a fail (caught by the runner).

const EPS = 1e-9;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const wireOk = (w) => !!(w && w.data && w.data.length);

// Build a policy override that hijacks the skill with hostile output (NaN, ±Inf, wild out-of-range).
const hijack = (skill, dof) => ({
  ...skill,
  policyMod: { create: () => ({ step: () => Array.from({ length: dof }, (_, i) => [NaN, 9, -5, Infinity, 42, -1e6][i % 6]) }) },
});

// action-space bounds implied by a manifest (mirrors the runtime contract, used only to check declarations)
function envelopeOf(m) {
  const a = m.requires.actuation;
  if (a === 'velocity') return { symmetric: true, cap: 'max_accel_norm', bound: 'max_speed_norm' };
  if (a === 'torque') return { symmetric: true, cap: 'max_torque_rate_norm', bound: 'max_torque_norm' };
  return { symmetric: false, cap: 'max_step_norm', bound: null };   // position
}

export const REQUIREMENTS = [
  // ── SKILL level ────────────────────────────────────────────────────────────────────────────────
  {
    id: 'SKILL-MANIFEST', level: 'skill', area: 'manifest', spec: 'SPEC §manifest',
    must: 'A skill MUST have a manifest with the required fields and a well-formed safety envelope.',
    run: ({ skill, core }) => { core.validateSkill(skill.manifest); return { pass: true, detail: `${skill.manifest.name}@${skill.manifest.version}` }; },
  },
  {
    id: 'SKILL-SAFETY-DECL', level: 'skill', area: 'envelope', spec: 'SPEC §the load-bearing idea',
    must: 'A skill MUST declare an action-space safety envelope matching its actuation (position→max_step, velocity→max_speed+max_accel, torque→max_torque+max_torque_rate).',
    run: ({ skill }) => {
      const m = skill.manifest, e = envelopeOf(m), s = m.safety || {};
      const capOk = finite(s[e.cap]) && s[e.cap] > 0;
      const boundOk = e.bound ? (finite(s[e.bound]) && s[e.bound] > 0) : finite(s.max_step_norm);
      return { pass: capOk && boundOk, detail: `${m.requires.actuation}: ${e.cap}=${s[e.cap]}${e.bound ? `, ${e.bound}=${s[e.bound]}` : ''}` };
    },
  },
  {
    id: 'SKILL-REQUIRES', level: 'skill', area: 'capability', spec: 'SPEC §capability negotiation',
    must: 'A skill MUST declare requires{morphology, min_dof, actuation} so a robot can be gated before motion.',
    run: ({ skill }) => {
      const r = skill.manifest.requires || {};
      const ok = typeof r.morphology === 'string' && finite(r.min_dof) && typeof r.actuation === 'string';
      return { pass: ok, detail: `morphology=${r.morphology}, min_dof=${r.min_dof}, actuation=${r.actuation}` };
    },
  },
  {
    id: 'SKILL-CONTRACT', level: 'skill', area: 'manifest', spec: 'SPEC §the typed contract',
    must: 'A skill MUST declare a typed contract: pre-conditions, post-conditions, and invariants.',
    run: ({ skill }) => {
      const k = skill.manifest.contract || {};
      const arr = (x) => Array.isArray(x) && x.length > 0;
      return { pass: arr(k.pre) && arr(k.post) && arr(k.invariants), detail: `pre:${(k.pre || []).length} post:${(k.post || []).length} inv:${(k.invariants || []).length}` };
    },
  },
  {
    id: 'SKILL-EVAL', level: 'skill', area: 'eval', spec: 'SPEC §eval',
    must: 'A skill MUST ship an eval declaring an environment and a metric.',
    run: ({ skill }) => {
      const ev = skill.manifest.eval || skill.evalSpec || {};
      return { pass: !!ev.environment && !!(ev.metric || ev.threshold || ev.episodes), detail: `env=${ev.environment}, metric=${ev.metric || (ev.threshold != null ? 'threshold' : (ev.episodes ? 'episodes' : '—'))}` };
    },
  },
  {
    id: 'SKILL-CAP-GATE', level: 'skill', area: 'capability', spec: 'SPEC §capability negotiation',
    must: 'Capability matching MUST accept a compatible robot and REFUSE an under-provisioned one, with reasons.',
    run: ({ skill, robot, core }) => {
      const m = skill.manifest;
      const good = core.matchRobot(m, robot);
      const tooFew = { ...robot, dof: Math.max(0, m.requires.min_dof - 1) };
      const bad = core.matchRobot(m, tooFew);
      const pass = good.ok === true && bad.ok === false && Array.isArray(bad.reasons) && bad.reasons.length > 0;
      return { pass, detail: `compatible→ok=${good.ok}; dof-1→ok=${bad.ok} (${(bad.reasons || [])[0] || 'no reason'})` };
    },
  },

  // ── RUNTIME level ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'RT-ENVELOPE-CLAMP', level: 'runtime', area: 'envelope', spec: 'SPEC §the load-bearing idea',
    must: 'The runtime MUST bound a HIJACKED policy inside the declared range every tick, and always emit a well-formed wire command.',
    run: async ({ skill, robot, runtime }) => {
      const rt = await runtime.bind(hijack(skill, robot.dof), robot, {});
      const { lo, hi } = rt.envelope; let bad = 0;
      for (let k = 0; k < 40; k++) { const t = rt.step({}); if (!wireOk(t.wire) || t.q.some((v) => !finite(v) || v < lo - EPS || v > hi + EPS)) bad++; }
      return { pass: bad === 0, detail: `40 hostile ticks, ${bad} escaped [${lo}, ${hi}]` };
    },
  },
  {
    id: 'RT-STEP-CAP', level: 'runtime', area: 'envelope', spec: 'SPEC §the load-bearing idea',
    must: 'The runtime MUST NOT let the per-tick change exceed the declared rate cap, even for a hijacked policy.',
    run: async ({ skill, robot, runtime }) => {
      const rt = await runtime.bind(hijack(skill, robot.dof), robot, {});
      const cap = rt.envelope.maxStep; let prev = rt.state(), worst = 0;
      for (let k = 0; k < 40; k++) { const t = rt.step({}); for (let i = 0; i < t.q.length; i++) worst = Math.max(worst, Math.abs(t.q[i] - prev[i])); prev = t.q; }
      return { pass: worst <= cap + EPS, detail: `max per-tick step ${worst.toFixed(4)} ≤ cap ${cap}` };
    },
  },
  {
    id: 'RT-NAN-REJECT', level: 'runtime', area: 'envelope', spec: 'SPEC §invariants',
    must: 'The runtime MUST NOT propagate NaN/Inf from a policy to the wire.',
    run: async ({ skill, robot, runtime }) => {
      const rt = await runtime.bind({ ...skill, policyMod: { create: () => ({ step: () => new Array(robot.dof).fill(NaN) }) } }, robot, {});
      let bad = 0;
      for (let k = 0; k < 10; k++) { const t = rt.step({}); if (t.q.some((v) => !finite(v)) || !wireOk(t.wire)) bad++; }
      return { pass: bad === 0, detail: `all-NaN policy for 10 ticks, ${bad} leaked` };
    },
  },
  {
    id: 'RT-ESTOP', level: 'runtime', area: 'lifecycle', spec: 'SPEC §the runtime',
    must: 'estop() MUST return a command inside the safe range (zero for symmetric velocity/torque spaces).',
    run: async ({ skill, robot, runtime }) => {
      const rt = await runtime.bind(hijack(skill, robot.dof), robot, {});
      for (let k = 0; k < 5; k++) rt.step({});
      const e = rt.estop(); const { lo, hi, } = rt.envelope;
      const inRange = e.every((v) => finite(v) && v >= lo - EPS && v <= hi + EPS);
      const zeroIfSym = !rt.symmetric || e.every((v) => Math.abs(v) < EPS);
      return { pass: inRange && zeroIfSym, detail: `estop=[${e.slice(0, 3).map((v) => v.toFixed(2)).join(', ')}…] symmetric=${rt.symmetric}` };
    },
  },
  {
    id: 'RT-RESET-HOME', level: 'runtime', area: 'lifecycle', spec: 'SPEC §the runtime',
    must: 'reset() MUST return the runtime to a safe home state inside the declared range.',
    run: async ({ skill, robot, runtime }) => {
      const rt = await runtime.bind(hijack(skill, robot.dof), robot, {});
      for (let k = 0; k < 8; k++) rt.step({});
      rt.reset(); const s = rt.state(); const { lo, hi } = rt.envelope;
      const inRange = s.every((v) => finite(v) && v >= lo - EPS && v <= hi + EPS);
      const zeroIfSym = !rt.symmetric || s.every((v) => Math.abs(v) < EPS);
      return { pass: inRange && zeroIfSym, detail: `home=[${s.slice(0, 3).map((v) => v.toFixed(2)).join(', ')}…]` };
    },
  },
  {
    id: 'RT-SYMMETRIC-ZERO', level: 'runtime', area: 'actuation', spec: 'SPEC §v0.2.1 action spaces',
    must: 'A symmetric (velocity/torque) runtime MUST start from zero command.',
    applies: ({ skill }) => envelopeOf(skill.manifest).symmetric,
    run: async ({ skill, robot, runtime }) => {
      const rt = await runtime.bind(skill, robot, {});
      const s = rt.state();
      return { pass: rt.symmetric && s.every((v) => Math.abs(v) < EPS), detail: `symmetric=${rt.symmetric}, |state|max=${Math.max(...s.map(Math.abs)).toFixed(4)}` };
    },
  },
];

export const LEVELS = ['skill', 'runtime'];
export const requirementsFor = (level) => REQUIREMENTS.filter((r) => r.level === level);
