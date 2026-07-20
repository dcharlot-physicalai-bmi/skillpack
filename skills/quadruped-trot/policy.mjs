// quadruped-trot · a central-pattern-generator (CPG) gait. 12 DoF = 4 legs × (hip-abduction, thigh, calf).
// Trot = the two diagonal leg pairs move in antiphase: FL+RR at phase φ, FR+RL at φ+π. Each leg's thigh and
// calf oscillate around a neutral stance; the calf lags the thigh so the foot lifts on swing. The policy is
// stateful (it carries the gait phase); the runtime still bounds every command — the frequency + amplitude
// are chosen so the per-tick step stays under the velocity cap, so the gait flows through the envelope clean.
//
// Leg order: FL(0-2) FR(3-5) RL(6-8) RR(9-11). Diagonal pairs: {FL,RR} and {FR,RL}.

const NEUTRAL = 0.5, THIGH_AMP = 0.16, CALF_AMP = 0.13, CALF_LAG = Math.PI / 2, FREQ = 0.9, DT = 0.05; // 20 Hz

export function create(skill, robot) {
  const dof = robot.dof;                 // 12
  const legPhase = [0, Math.PI, Math.PI, 0];  // FL, FR, RL, RR → trot (diagonals in phase)
  let t = 0;
  return {
    reset() { t = 0; },
    step() {
      const base = 2 * Math.PI * FREQ * t;
      const q = new Array(dof).fill(NEUTRAL);
      for (let leg = 0; leg < 4 && leg * 3 + 2 < dof; leg++) {
        const p = base + legPhase[leg];
        q[leg * 3 + 0] = NEUTRAL;                                        // hip-abduction: roughly static
        q[leg * 3 + 1] = NEUTRAL + THIGH_AMP * Math.sin(p);             // thigh
        q[leg * 3 + 2] = NEUTRAL + CALF_AMP * Math.sin(p + CALF_LAG);   // calf (lifts on swing)
      }
      t += DT;
      return q;
    },
  };
}
