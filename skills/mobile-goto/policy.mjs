// mobile-goto · analytic velocity policy. Proposes a velocity proportional to the error to the goal
// (a P-controller in velocity space). The runtime clamps it to the speed + acceleration envelope — so an
// aggressive gain, or a hijacked policy, still can't exceed the base's safe speed.
export function create(skill, robot) {
  const dof = robot.dof; // 2 → (vx, vy)
  const K = 3.0;         // deliberately high gain; the envelope is what makes it safe
  return {
    reset() {},
    // obs = { pose: [x, y], goal: [x, y] }
    step(obs) {
      const pose = obs.pose || obs.q || new Array(dof).fill(0);
      const goal = obs.goal || obs.q_target || new Array(dof).fill(0);
      const v = new Array(dof);
      for (let i = 0; i < dof; i++) v[i] = K * ((goal[i] ?? 0) - (pose[i] ?? 0));
      return v;
    },
  };
}
