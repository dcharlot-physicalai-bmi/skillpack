// arm-compliant-push · impedance control in TORQUE space. Proposes a joint torque that pulls toward the
// target like a spring-damper: τ = K·(q_target − q) − D·q̇. That is COMPLIANT — push back on the arm and it
// yields — and the runtime bounds |τ| to a force limit, so a contact task can't apply an unsafe force. An
// aggressive stiffness, or a hijacked policy, still can't exceed the force envelope.
const K = 4.0, D = 0.6;
export function create(skill, robot) {
  const dof = robot.dof;
  return {
    reset() {},
    // obs = { q, q_target, q_dot }  (torque is normalized; the runtime clamps to [-max_torque, +max_torque])
    step(obs) {
      const q = obs.q || new Array(dof).fill(0.5), qt = obs.q_target || q, qd = obs.q_dot || new Array(dof).fill(0);
      return Array.from({ length: dof }, (_, i) => K * ((qt[i] ?? 0.5) - (q[i] ?? 0.5)) - D * (qd[i] ?? 0));
    },
  };
}
