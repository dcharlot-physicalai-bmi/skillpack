// gripper-grasp · analytic baseline. Proposes the grasp target config (approach pose with the gripper
// joint closed); the runtime envelope ramps it under the velocity cap. Swap policy.kind → "lerobot" for
// a trained grasp checkpoint on the same contract.
export function create(skill, robot) {
  const dof = robot.dof;
  return {
    reset() {},
    step(obs) { const qt = obs.q_target; const out = new Array(dof); for (let i = 0; i < dof; i++) out[i] = qt[i]; return out; },
  };
}
