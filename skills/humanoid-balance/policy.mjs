// humanoid-balance · an ankle/hip balance controller (capture-point style). Reads the center-of-mass
// offset and velocity; commands the center of pressure AHEAD of the CoM so the inverted-pendulum torque
// pulls the CoM back over the support polygon. Ankles do the fine work; hips assist for larger errors;
// the other joints hold a neutral stance. The runtime bounds every joint (ankle rate = the velocity cap).
//
// Joint layout (20): 0 l-ankle-pitch 1 l-ankle-roll 2 r-ankle-pitch 3 r-ankle-roll
//                    4 l-hip-pitch 5 r-hip-pitch 6.. knees/torso/arms (neutral)

const KP = 1.6, KD = 0.45, HIP = 0.2;   // CoP = KP·com + KD·com_vel  (KP>1 ⇒ CoP leads CoM ⇒ restoring)
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

export function create(skill, robot) {
  const dof = robot.dof;
  return {
    reset() {},
    // obs = { com: [x, y], com_vel: [x, y] }  (normalized: ±1 = support-polygon edge)
    step(obs) {
      const com = obs.com || [0, 0], cv = obs.com_vel || [0, 0];
      const copX = clamp1(KP * com[0] + KD * cv[0]);   // fore-aft center of pressure (via ankle pitch)
      const copY = clamp1(KP * com[1] + KD * cv[1]);   // lateral (via ankle roll)
      const q = new Array(dof).fill(0.5);
      q[0] = q[2] = 0.5 + 0.5 * copX;                  // ankle pitch → CoP fore-aft
      q[1] = q[3] = 0.5 + 0.5 * copY;                  // ankle roll  → CoP lateral
      q[4] = q[5] = 0.5 + HIP * clamp1(com[0]);        // hip strategy assists for larger fore-aft errors
      return q;
    },
  };
}
