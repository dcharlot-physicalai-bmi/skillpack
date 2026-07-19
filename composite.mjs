// composite — a skill built from sub-skills. A composite is a sequence of steps, each naming a REGISTERED
// skill and its goal; the composite runtime gates each sub-skill against the robot, drives it through ITS
// OWN safety envelope, and checkpoints between steps (durable). This is how skills compose into
// higher-level behaviors — pick-and-place = reach → grasp → carry — without giving up capability
// negotiation or the safety guarantee at any step.

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadSkill, matchRobot } from './skillkit.mjs';
import { driveTo } from './durable.mjs';

// Load a composite (composite.json) and resolve every step's sub-skill from the registry.
export async function loadComposite(dir, pkgRoot) {
  const spec = JSON.parse(await readFile(resolve(dir, 'composite.json'), 'utf8'));
  const registry = JSON.parse(await readFile(join(pkgRoot, 'registry.json'), 'utf8'));
  const steps = [];
  for (const step of spec.steps) {
    const entry = registry.skills.find((s) => s.name === step.skill);
    if (!entry) throw new Error(`composite "${spec.name}" references unknown skill "${step.skill}"`);
    const skill = await loadSkill(join(pkgRoot, entry.path));
    steps.push({ ...step, skill });
  }
  return { spec, steps };
}

// Check the composite (and every sub-skill) against a robot — a composite runs only if ALL its steps do.
export function matchComposite(composite, robot) {
  const reasons = [];
  const top = matchRobot({ requires: composite.spec.requires }, robot);
  if (!top.ok) reasons.push(...top.reasons.map((r) => `composite: ${r}`));
  for (const step of composite.steps) {
    const m = matchRobot(step.skill.manifest, robot);
    if (!m.ok) reasons.push(...m.reasons.map((r) => `step ${step.skill}: ${r}`));
  }
  return { ok: reasons.length === 0, reasons };
}

// Execute the steps in order, each through its own bound runtime, checkpointing after each. `faultAfter`
// simulates a crash/intervention right after that step index (returns the durable checkpoint).
export async function runComposite(composite, robot, opts = {}) {
  const { q0, faultAfter = null, onCheckpoint } = opts;
  let world = (q0 || new Array(robot.dof).fill(0.5)).slice();
  const done = [], log = [];
  let totalTicks = 0;
  for (let i = 0; i < composite.steps.length; i++) {
    const step = composite.steps[i];
    // gate this sub-skill before it moves (per-step capability check)
    if (!matchRobot(step.skill.manifest, robot).ok) return { status: 'refused', at: i, skill: step.skill.manifest.name };
    const r = await driveTo(step.skill, robot, world, step.goal, { ...opts, ...step });
    world = r.world; totalTicks += r.ticks;
    log.push({ step: i, skill: step.skill.manifest.name, reached: r.reached, ticks: r.ticks });
    if (!r.reached) return { status: 'failed', at: i, checkpoint: { done: [...done], world: [...world], nextStep: i }, log };
    done.push(i);
    const checkpoint = { done: [...done], world: [...world], nextStep: i + 1 };
    onCheckpoint?.(checkpoint);
    if (faultAfter === i) return { status: 'faulted', checkpoint, log, totalTicks };
  }
  return { status: 'complete', world, done, log, totalTicks };
}

// Resume from a checkpoint. Progress-aware: roll back any completed step whose goal no longer holds.
export async function resumeComposite(composite, robot, checkpoint, opts = {}) {
  const { tol = 0.03 } = opts;
  const maxErr = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  let done = [...checkpoint.done];
  let world = [...checkpoint.world];
  while (done.length) {
    const last = done[done.length - 1];
    if (maxErr(world, composite.steps[last].goal) > (composite.steps[last].tol ?? tol)) done.pop(); else break;
  }
  const rolledBack = checkpoint.done.length - done.length;
  let workTicks = 0; const executed = [];
  for (let i = done.length; i < composite.steps.length; i++) {
    const step = composite.steps[i];
    const r = await driveTo(step.skill, robot, world, step.goal, { ...opts, ...step });
    world = r.world; workTicks += r.ticks; executed.push(i);
    if (!r.reached) return { status: 'failed', at: i };
    done.push(i);
  }
  return { status: 'complete', world, done, resumedFromSteps: checkpoint.done.length, rolledBack, executedOnResume: executed, workTicks };
}
