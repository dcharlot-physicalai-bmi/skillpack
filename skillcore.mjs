// skillcore — the PURE skillpack logic, with zero environment dependencies (no node:fs, no browser
// globals). The one source of truth for validation, capability negotiation, and the safety envelope,
// shared by the Node runtime (skillkit), the CLI (bin/skillpack), and the in-browser demo.

export function validateSkill(m) {
  const need = ['name', 'version', 'policy', 'requires', 'safety', 'contract'];
  const missing = need.filter((k) => !(k in m));
  if (missing.length) throw new Error(`skill.json missing required field(s): ${missing.join(', ')}`);
  if (!m.requires.morphology || !m.requires.min_dof) throw new Error('requires{} needs morphology + min_dof');
  // position → per-tick step; velocity → speed + accel; torque → magnitude + rate.
  const posOk = typeof m.safety.max_step_norm === 'number';
  const velOk = typeof m.safety.max_speed_norm === 'number' && typeof m.safety.max_accel_norm === 'number';
  const torOk = typeof m.safety.max_torque_norm === 'number' && typeof m.safety.max_torque_rate_norm === 'number';
  if (!posOk && !velOk && !torOk) throw new Error('safety needs max_step_norm (position), max_speed_norm+max_accel_norm (velocity), or max_torque_norm+max_torque_rate_norm (torque)');
  return true;
}

// Capability negotiation — "will this run on MY robot?" — answered BEFORE any motion.
export function matchRobot(manifest, robot) {
  const req = manifest.requires, reasons = [];
  if (robot.morphology !== req.morphology)
    reasons.push(`morphology: skill needs "${req.morphology}", robot is "${robot.morphology}"`);
  if (robot.dof < req.min_dof)
    reasons.push(`dof: skill needs ≥${req.min_dof}, robot has ${robot.dof}`);
  if (req.actuation && robot.actuation !== req.actuation)
    reasons.push(`actuation: skill needs "${req.actuation}", robot is "${robot.actuation}"`);
  const have = new Set(robot.sensors || []);
  const miss = (req.sensors || []).filter((s) => !have.has(s));
  if (miss.length) reasons.push(`sensors: missing ${miss.map((s) => `"${s}"`).join(', ')}`);
  return { ok: reasons.length === 0, reasons };
}

// The runtime safety envelope — enforced around ANY policy. Clamp each channel to [lo,hi], reject
// non-finite (hold last), and cap the per-tick step vs the last command.
export function safetyClamp(prev, cmd, { maxStep, lo = 0, hi = 1 }) {
  return cmd.map((raw, i) => {
    let v = Number.isFinite(raw) ? raw : prev[i];
    v = Math.max(lo, Math.min(hi, v));
    const p = prev[i];
    if (v - p > maxStep) v = p + maxStep;
    else if (p - v > maxStep) v = p - maxStep;
    return v;
  });
}
