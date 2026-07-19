// evalkit — recovery-aware evaluation for skillpack skills. The blueprint's Opening #4: robotics keeps
// saying eval is the missing infrastructure, and that success rate alone hides the dominant real-world
// failure — execution instability. evalkit closes a real loop: the skill's safety-bounded command drives
// a world with first-order joint dynamics; disturbances (shoves) are injected mid-episode; and the harness
// reports not just success but RECOVERY, time-to-target, stability, and a failure taxonomy.
//
// It reuses the real runtime (skillkit.bind): the policy proposes, the safety envelope bounds the command,
// and the world responds to the command — so the eval measures the same thing that would drive hardware.

import { bind } from './skillkit.mjs';

// A world with first-order lag: q_world moves a fraction `alpha` toward the commanded position each tick.
// Disturbances displace q_world directly (a shove), which the closed loop must recover from.
function stepWorld(world, cmd, alpha, disturb) {
  const next = world.map((w, i) => w + alpha * (cmd[i] - w));
  if (disturb) for (let i = 0; i < next.length; i++) next[i] = Math.max(0, Math.min(1, next[i] + (disturb[i] || 0)));
  return next;
}

const maxErr = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

// Evaluate a skill on a robot. Episodes come from the skill's eval.json (or `opts.episodes`).
// opts: { alpha, tol, maxTicks, shoveTick, shoveMag, policyOpts }
export async function evaluate(skill, robot, opts = {}) {
  const dof = robot.dof;
  const spec = skill.evalSpec || {};
  const episodes = opts.episodes || spec.episodes || [];
  if (!episodes.length) throw new Error(`${skill.manifest.name}: no eval episodes (this skill evals in ${spec.environment || 'another environment'})`);
  const alpha = opts.alpha ?? 0.5;
  const tol = opts.tol ?? spec.tolerance ?? 0.03;
  const maxTicks = opts.maxTicks ?? spec.max_ticks ?? 80;
  const shoveTick = opts.shoveTick ?? null;                 // null → clean run
  const shoveMag = opts.shoveMag ?? 0.35;

  const results = [];
  for (const ep of episodes) {
    const rt = await bind(skill, robot, { q0: ep.q0.slice(), policyOpts: opts.policyOpts });
    let world = ep.q0.slice();
    let reached = -1, shoved = false, cmdJitter = 0, prevCmd = ep.q0.slice();
    for (let k = 0; k < maxTicks; k++) {
      const t = rt.step({ q: world, q_target: ep.q_target, state: world, image: null, task: skill.manifest.task });
      for (let i = 0; i < dof; i++) cmdJitter += Math.abs(t.q[i] - prevCmd[i]);
      prevCmd = t.q;
      // deterministic shove: push HALF the joints one way, half the other, at shoveTick
      let disturb = null;
      if (shoveTick != null && k === shoveTick) { disturb = t.q.map((_, i) => (i % 2 ? shoveMag : -shoveMag)); shoved = true; }
      world = stepWorld(world, t.q, alpha, disturb);
      if (maxErr(world, ep.q_target) < tol && reached < 0) reached = k + 1;   // first arrival (time-to-target)
    }
    // success = SETTLED at the goal at the end (reaching then drifting out is a failure, not a pass).
    const finalErr = maxErr(world, ep.q_target);
    const settled = finalErr < tol;
    results.push({ reached, ticks: reached >= 0 ? reached : maxTicks, ok: settled, finalErr, shoved,
                   unstable: reached >= 0 && !settled, cmdJitter });   // arrived but didn't hold = instability
  }

  const n = results.length;
  const passed = results.filter((r) => r.ok).length;
  const reachedTicks = results.filter((r) => r.reached >= 0).map((r) => r.reached);
  const failures = {
    timeout: results.filter((r) => r.reached < 0).length,
    unstable: results.filter((r) => r.unstable).length,
    lost_after_shove: results.filter((r) => r.shoved && r.finalErr >= tol).length,
  };
  return {
    skill: skill.manifest.name, robot: robot.name, episodes: n, shoved: shoveTick != null,
    success_rate: passed / n,
    mean_ticks: reachedTicks.length ? +(reachedTicks.reduce((a, b) => a + b, 0) / reachedTicks.length).toFixed(1) : null,
    mean_command_jitter: +(results.reduce((a, r) => a + r.cmdJitter, 0) / n).toFixed(3),
    failures,
  };
}

// A recovery report: clean vs shoved, side by side. Recovery rate = success under a mid-episode shove.
export async function recoveryReport(skill, robot, opts = {}) {
  const clean = await evaluate(skill, robot, { ...opts, shoveTick: null });
  const shoveTick = opts.shoveTick ?? Math.round((opts.maxTicks ?? skill.evalSpec?.max_ticks ?? 80) * 0.6);
  const shoved = await evaluate(skill, robot, { ...opts, shoveTick });
  return {
    skill: skill.manifest.name, robot: robot.name,
    clean_success_rate: clean.success_rate,
    recovery_rate: shoved.success_rate,             // success despite a shove at 60% of the horizon
    mean_ticks: clean.mean_ticks,
    stability: 1 - (shoved.failures.unstable / Math.max(1, shoved.episodes)),
    clean, shoved,
  };
}
