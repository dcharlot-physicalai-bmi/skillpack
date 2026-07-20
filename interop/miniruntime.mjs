// miniruntime — a SECOND, independent skillpack runtime, written clean-room. It shares NO code with
// skillkit/skillcore: its own envelope math, its own clamp, its own trivial wire encoder. Its only job
// is to prove the standard is implementable by someone other than us — if this passes the conformance
// battery, "skillpack-conformant runtime" means a real, portable contract, not a description of our code.
//
// The contract a conformant bind() must satisfy (see conformance/README.md):
//   bind(skill, robot, opts) → { envelope:{lo,hi,maxStep}, symmetric, step(obs)→{q,wire}, estop(), reset(), state() }

// derive the action-space envelope from the manifest — position/velocity/torque, same as the spec says.
function envelope(m, dof) {
  const a = m.requires.actuation;
  if (a === 'velocity') return { lo: -m.safety.max_speed_norm, hi: m.safety.max_speed_norm, maxStep: m.safety.max_accel_norm, symmetric: true };
  if (a === 'torque') return { lo: -m.safety.max_torque_norm, hi: m.safety.max_torque_norm, maxStep: m.safety.max_torque_rate_norm, symmetric: true };
  const [lo, hi] = m.safety.clamp || [0, 1];
  return { lo, hi, maxStep: m.safety.max_step_norm, symmetric: false };
}

// clamp one command against the previous one: reject non-finite, cap the per-tick change, clamp to range.
function clampOne(prevV, propV, lo, hi, maxStep) {
  let v = Number.isFinite(propV) ? propV : prevV;          // NaN/±Inf → hold previous (never propagate)
  const d = v - prevV;
  if (d > maxStep) v = prevV + maxStep;                    // rate cap (both directions)
  else if (d < -maxStep) v = prevV - maxStep;
  if (v < lo) v = lo; else if (v > hi) v = hi;             // range clamp
  return v;
}

export function bind(skill, robot, { policyOpts } = {}) {
  const m = skill.manifest, dof = robot.dof;
  const env = envelope(m, dof);
  const home = () => new Array(dof).fill(env.symmetric ? 0 : 0.5);
  const policy = skill.policyMod.create(m, robot, policyOpts);
  let prev = home();

  return {
    envelope: { lo: env.lo, hi: env.hi, maxStep: env.maxStep },
    symmetric: env.symmetric,
    state: () => prev.slice(),
    reset() { prev = home(); policy.reset?.(); },
    estop() { return env.symmetric ? new Array(dof).fill(0) : prev.slice(); },
    step(obs) {
      const proposed = policy.step(obs) || [];
      const safe = prev.map((p, i) => clampOne(p, proposed[i], env.lo, env.hi, env.maxStep));
      prev = safe;
      // an independent (trivial) wire encoder — proves the runtime contract is codec-agnostic.
      const wire = { data: safe.map((v) => Math.round(((v - env.lo) / ((env.hi - env.lo) || 1)) * 255)) };
      return { q: safe.slice(), proposed, wire };
    },
  };
}
