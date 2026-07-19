// durable — a durable execution runtime for multi-step skills. The blueprint's Opening #3: the physical
// world can't be replayed, but a long-horizon task's PROGRESS can be checkpointed so a fault or a human
// intervention doesn't restart it from zero. And — the Crab (2026) insight — checkpoints must be
// semantics-aware: on resume, verify the world still satisfies each completed step; if a disturbance
// regressed it, roll back to the last step that actually holds and redo from there.
//
// A durable skill runs over WAYPOINTS (sub-goals). After each, it emits a serializable checkpoint. resume()
// takes a checkpoint, validates it against the current world (progress-aware rollback), and finishes the
// remaining work — without redoing what already holds.

import { bind } from './skillkit.mjs';

const maxErr = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

// Drive the world to one waypoint through the skill's safety-bounded runtime. Optional mid-drive shove.
// Exported so composite skills can reuse it to drive each sub-skill step.
export async function driveTo(skill, robot, world0, target, opts = {}) {
  const { tol = 0.03, maxTicks = 80, alpha = 0.5, shoveAt = null, shoveMag = 0.35, policyOpts } = opts;
  const rt = await bind(skill, robot, { q0: world0.slice(), policyOpts });
  let world = world0.slice(), reached = false, ticks = 0;
  for (let k = 0; k < maxTicks; k++) {
    const t = rt.step({ q: world, q_target: target, state: world, image: null, task: skill.manifest.task });
    const disturb = shoveAt === k ? t.q.map((_, i) => (i % 2 ? shoveMag : -shoveMag)) : null;
    world = world.map((w, i) => { let n = w + alpha * (t.q[i] - w); if (disturb) n = Math.max(0, Math.min(1, n + disturb[i])); return n; });
    ticks = k + 1;
    if (maxErr(world, target) < tol) { reached = true; break; }
  }
  return { world, reached, ticks };
}

// Execute waypoints in order, checkpointing after each. `faultAfter` simulates a crash/intervention
// right after that waypoint index (the run stops and returns its checkpoint — durable state).
export async function runDurable(skill, robot, waypoints, opts = {}) {
  const { q0, faultAfter = null, onCheckpoint } = opts;
  let world = (q0 || waypoints[0].q0 || new Array(robot.dof).fill(0.5)).slice();
  const done = [];
  let totalTicks = 0;
  for (let i = 0; i < waypoints.length; i++) {
    const r = await driveTo(skill, robot, world, waypoints[i].target, { ...opts, ...waypoints[i] });
    world = r.world; totalTicks += r.ticks;
    if (!r.reached) return { status: 'failed', at: i, checkpoint: { done: [...done], world: [...world], nextWaypoint: i } };
    done.push(i);
    const checkpoint = { done: [...done], world: [...world], nextWaypoint: i + 1 };
    onCheckpoint?.(checkpoint);
    if (faultAfter === i) return { status: 'faulted', checkpoint, totalTicks }; // crash / intervention here
  }
  return { status: 'complete', world, done, totalTicks };
}

// Resume from a checkpoint. PROGRESS-AWARE: before continuing, roll back any completed waypoint whose
// postcondition (within tol of its target) no longer holds in the current world — then redo from there.
export async function resume(skill, robot, waypoints, checkpoint, opts = {}) {
  const { tol = 0.03 } = opts;
  let done = [...checkpoint.done];
  const world0 = [...checkpoint.world];
  // roll back regressed progress (semantics-aware, not blind trust in the index)
  while (done.length) {
    const last = done[done.length - 1];
    const wtol = waypoints[last].tol ?? tol;
    if (maxErr(world0, waypoints[last].target) > wtol) done.pop(); else break;
  }
  const rolledBack = checkpoint.done.length - done.length;

  let world = world0, workTicks = 0, redoneOrRemaining = [];
  for (let i = done.length; i < waypoints.length; i++) {
    const r = await driveTo(skill, robot, world, waypoints[i].target, { ...opts, ...waypoints[i] });
    world = r.world; workTicks += r.ticks; redoneOrRemaining.push(i);
    if (!r.reached) return { status: 'failed', at: i };
    done.push(i);
  }
  return {
    status: 'complete', world, done,
    resumedFromWaypoints: checkpoint.done.length,   // how much was already durable-complete
    rolledBack,                                      // waypoints invalidated by regression and redone
    executedOnResume: redoneOrRemaining,             // which waypoints actually ran on resume
    workTicks,                                        // work spent on resume (durability = this stays small)
  };
}
