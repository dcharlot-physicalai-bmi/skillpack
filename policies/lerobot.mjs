// Generic LeRobot policy adapter — the composition mechanism. LeRobot standardized the policy
// interface: ACT, DiffusionPolicy, TDMPC2, VQ-BeT, SmolVLA, π0 all expose `.select_action(obs)`, so a
// SINGLE adapter drives ANY of them. A skill names a checkpoint (policy.checkpoint: "hf://lerobot/…");
// this wraps it behind the skillpack policy interface — same contract, safety envelope, transport.
//
// The real checkpoint runs in the deployment's LeRobot runtime (Python, or on-device where exported);
// inference is injected as opts.backend.selectAction(obs) so the same file works in-browser, over a
// LeRobot bridge, or — in the Node harness — with a stand-in that validates the contract + safety.

export function create(skill, robot, opts = {}) {
  const dof = robot.dof;
  const backend = opts && opts.backend;
  const checkpoint = skill.policy && skill.policy.checkpoint;
  if (!backend || typeof backend.selectAction !== 'function')
    throw new Error(`lerobot adapter for "${checkpoint}" needs a backend {selectAction(obs)->number[]}. ` +
      'In deployment: a LeRobot runtime bridge; in tests: a stand-in.');

  // Action chunking: ACT/Diffusion emit a horizon of actions per call; consume it before re-inferring.
  const horizon = (skill.policy && skill.policy.chunking) || 1;
  let chunk = null, cursor = 0;

  return {
    reset() { chunk = null; cursor = 0; },
    // obs is whatever the checkpoint was trained on (state, images, …). Returns the raw action for this
    // timestep — UNTRUSTED (a policy under distribution shift can emit out-of-range values). The
    // skillkit runtime safety envelope is what makes that safe; the adapter never clamps.
    step(obs) {
      if (!chunk || cursor >= horizon) { chunk = backend.selectAction(obs); cursor = 0; }
      // chunk may be a flat action (length ≥ dof) or a [horizon × actionDim] flat array
      const wide = chunk.length > dof;
      const base = wide ? cursor * (chunk.length / horizon) : 0;
      const a = new Array(dof);
      for (let i = 0; i < dof; i++) a[i] = chunk[base + i];
      cursor++;
      return a;
    },
  };
}
