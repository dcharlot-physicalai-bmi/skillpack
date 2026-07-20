// record — capture skill executions as demonstrations. Closes the learning loop back to LeRobot: run a
// skill, record (observation, action) per tick, and (via bridge/record_dataset.py) write a real
// LeRobotDataset. Train on it with LeRobot, and the checkpoint becomes a `lerobot`-kind skill — the
// flywheel: skillpack composes LeRobot's policies AND feeds LeRobot's datasets.
//
// The recorded action is the SAFETY-ENVELOPED command — so the demonstrations are envelope-clean by
// construction (you never record an unsafe action).

import { bind } from './skillkit.mjs';

const maxErr = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

// Run the skill toward each target through a first-order world, recording obs.state + the safe command.
export async function recordEpisodes(skill, robot, targets, opts = {}) {
  const { alpha = 0.5, tol = 0.03, maxTicks = 60, fps = 20 } = opts;
  const dof = robot.dof;
  const episodes = [];
  for (const target of targets) {
    const rt = await bind(skill, robot, { q0: new Array(dof).fill(0.5) });
    let world = new Array(dof).fill(0.5);
    const frames = [];
    for (let k = 0; k < maxTicks; k++) {
      const t = rt.step({ q: world, q_target: target, state: world });
      frames.push({ state: world.slice(), action: t.q.slice() });   // obs.state, then the envelope-bounded action
      world = world.map((w, i) => w + alpha * (t.q[i] - w));
      if (maxErr(world, target) < tol) { frames.push({ state: world.slice(), action: t.q.slice() }); break; }
    }
    episodes.push({ task: skill.manifest.task || skill.manifest.name, frames });
  }
  return { fps, state_dim: dof, action_dim: dof, episodes };
}
