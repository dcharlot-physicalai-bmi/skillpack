// arm-reach · POLICY layer.
//
// A policy is a pure-ish module exporting `create(skill, robot) -> { reset(), step(obs) -> action }`.
// It PROPOSES an action in the skill's action space; it does NOT enforce safety — the runtime does.
// That separation is the whole point: the same runtime envelope wraps ANY policy, trained or not.
//
// This reference policy is an analytic P-controller so the eval is deterministic and hardware-free.
// A real deployment swaps the manifest's `policy.kind` to "lerobot"/"mlp" and this file for a loader
// that runs a checkpoint (ACT / SmolVLA / pi0). The contract and the runtime are unchanged.

export function create(skill, robot) {
  const dof = robot.dof;
  return {
    reset() {},
    // obs = { q: number[dof] (current, normalized 0..1), q_target: number[dof] (desired) }
    // Propose driving straight to the target. The runtime will ramp this under max_step_norm —
    // demonstrating that even an "aggressive" proposal is made safe by the envelope, not the policy.
    step(obs) {
      const q = obs.q, qt = obs.q_target;
      const out = new Array(dof);
      for (let i = 0; i < dof; i++) out[i] = qt[i];
      return out;
    },
  };
}
