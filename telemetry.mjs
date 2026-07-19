// telemetry — an auditable run-trace for skill executions. A safety-enveloped open registry needs to be
// able to PROVE, after the fact, exactly what the runtime did: which commands the policy proposed, which
// the envelope changed, and why. `traced(rt)` wraps a bound runtime (from skillkit.bind) and records a
// structured, JSON-serializable trace — the seed of observability for robot skills.
//
// It classifies every intervention by comparing the policy's proposal to the runtime's command against the
// exposed envelope: held (a non-finite proposal was replaced), clamped (hit the [lo,hi] range), capped (hit
// the per-tick velocity/accel limit), or pass (untouched).

const EPS = 1e-9;

export function traced(rt, meta = {}) {
  const { lo, hi, maxStep } = rt.envelope;
  let prev = rt.state();
  const ticks = [];
  const counts = { held: 0, clamped: 0, capped: 0, pass: 0 };
  let maxStepSeen = 0;

  function classify(proposed, cmd, p) {
    if (!Number.isFinite(proposed)) return 'held';
    if (cmd <= lo + EPS && proposed < lo) return 'clamped';
    if (cmd >= hi - EPS && proposed > hi) return 'clamped';
    if (Math.abs(cmd - p) >= maxStep - EPS && Math.abs(proposed - p) > maxStep) return 'capped';
    return 'pass';
  }

  return {
    ...rt,
    step(obs) {
      const t = rt.step(obs);
      const evs = t.q.map((c, i) => classify(t.proposed[i], c, prev[i]));
      evs.forEach((e) => counts[e]++);
      for (let i = 0; i < t.q.length; i++) maxStepSeen = Math.max(maxStepSeen, Math.abs(t.q[i] - prev[i]));
      ticks.push({ k: ticks.length, proposed: t.proposed.map(round), command: t.q.map(round), events: evs });
      prev = t.q;
      return t;
    },
    // the structured, serializable trace
    trace() {
      return {
        ...meta, mode: rt.velocity ? 'velocity' : 'position', envelope: { lo, hi, maxStep },
        ticks,
        summary: {
          n_ticks: ticks.length, interventions: counts,
          intervention_rate: +( (counts.held + counts.clamped + counts.capped) / Math.max(1, counts.held + counts.clamped + counts.capped + counts.pass) ).toFixed(3),
          max_step: +maxStepSeen.toFixed(4), within_cap: maxStepSeen <= maxStep + EPS,
        },
      };
    },
  };
}
const round = (v) => (Number.isFinite(v) ? +v.toFixed(4) : String(v));

// Replay a recorded command stream through a codec to confirm the trace reproduces the same wire — an
// audit trail you can re-derive, not just trust.
export function replayWire(trace, codec, ids) {
  return trace.ticks.map((t) => codec.encode(t.command, { ids }).text);
}
