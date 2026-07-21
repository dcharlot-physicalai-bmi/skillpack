// agent — the agentic layer. An AI planner turns a goal into an ordered sequence of skill invocations;
// the agent executes them on a robot. The load-bearing property, and the whole thesis of agentic PHYSICAL
// AI: safety lives BELOW the planner. No plan the agent can emit — a hallucination, a jailbreak, a
// compromised planner, an insane target — can (a) run a skill the robot can't support, or (b) drive any
// joint outside the safety envelope. The planner is untrusted; the runtime is the authority.
//
//   planAndRun({ goal, robot, skills, planner }) → { plan, steps, safe, refused }
//
// `planner(goal, catalog) → [{ skill, target }]` is ANY function — a rule-based stub, or an LLM (see
// llmPlanner below). The safety guarantees do not depend on which, because they are enforced here, not there.

import { matchRobot } from './skillcore.mjs';
import { bind } from './skillkit.mjs';
import { traced } from './telemetry.mjs';

const maxErr = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

// What the planner is allowed to see: only skills THIS robot can actually run (capability-first).
export function catalogFor(skills, robot) {
  return skills.filter((s) => matchRobot(s.manifest, robot).ok).map((s) => ({
    skill: s.manifest.name, title: s.manifest.title, morphology: s.manifest.requires.morphology,
    actuation: s.manifest.requires.actuation, summary: s.manifest.summary,
  }));
}

// Execute one planned step through the safety-enveloped + traced runtime. Returns reached + an auditable
// trace + the hard safety facts (every command in range, every per-tick step within the cap).
async function execStep(skill, robot, world0, target, { tol = 0.03, maxTicks = 80, alpha = 0.5 } = {}) {
  const rt = traced(await bind(skill, robot, { q0: world0.slice() }), { skill: skill.manifest.name });
  const { lo, hi, maxStep } = rt.envelope;
  const tgt = target.slice(0, robot.dof);
  let world = world0.slice(), reached = false, inRange = true;
  for (let k = 0; k < maxTicks; k++) {
    const t = rt.step({ q: world, q_target: tgt, state: world, task: skill.manifest.task });
    for (const v of t.q) if (!Number.isFinite(v) || v < lo - 1e-9 || v > hi + 1e-9) inRange = false;
    world = world.map((w, i) => w + alpha * (t.q[i] - w));
    if (maxErr(world.slice(0, tgt.length), tgt) < tol) { reached = true; break; }
  }
  const tr = rt.trace();
  return { reached, world, inRange, withinCap: tr.summary.within_cap, trace: tr };
}

export async function planAndRun({ goal, robot, skills, planner, world0, execOpts = {} }) {
  const byName = new Map(skills.map((s) => [s.manifest.name, s]));
  const catalog = catalogFor(skills, robot);
  const plan = (await planner(goal, catalog)) || [];

  let world = (world0 || new Array(robot.dof).fill(robot.symmetric ? 0 : 0.5)).slice();
  const steps = [];
  for (const p of plan) {
    const sk = byName.get(p.skill);
    // GUARD 1 — capability. An unknown or incompatible skill is refused before any motion, with reasons.
    if (!sk) { steps.push({ skill: p.skill, status: 'refused', reason: 'unknown skill (not in registry)' }); continue; }
    const m = matchRobot(sk.manifest, robot);
    if (!m.ok) { steps.push({ skill: p.skill, status: 'refused', reason: m.reasons.join(' · ') }); continue; }
    // GUARD 2 — the envelope. Whatever target the planner asked for is executed through the safety runtime,
    // which clamps range and caps rate; an insane target can only move the robot safely toward a safe bound.
    const target = Array.isArray(p.target) ? p.target : new Array(robot.dof).fill(0.5);
    const r = await execStep(sk, robot, world, target, execOpts);
    world = r.world;
    steps.push({ skill: p.skill, status: r.reached ? 'done' : 'incomplete', inRange: r.inRange, withinCap: r.withinCap, trace: r.trace });
  }

  const executed = steps.filter((s) => s.status === 'done' || s.status === 'incomplete');
  const safe = executed.every((s) => s.inRange && s.withinCap);   // the guarantee: every executed step stayed bounded
  return { goal, robot: robot.name, plan, steps, safe, refused: steps.filter((s) => s.status === 'refused').length };
}

// ── an optional LLM planner adapter (drop-in; not used by the hermetic verify) ───────────────────────
// The safety guarantees above hold for ANY planner, so a real LLM plugs in unchanged. This calls the
// Anthropic Messages API with the capability-matched catalog and asks for a JSON plan. It is deliberately
// thin: the model's authority ends at "which skill, what target" — the runtime bounds the rest.
export function llmPlanner({ apiKey = process.env.ANTHROPIC_API_KEY, model = 'claude-opus-4-8' } = {}) {
  return async function plan(goal, catalog) {
    if (!apiKey) throw new Error('llmPlanner needs ANTHROPIC_API_KEY');
    const sys = 'You are a robot task planner. Given a goal and a catalog of skills this robot can run, '
      + 'return ONLY a JSON array of steps: [{"skill":"<name from catalog>","target":[<normalized 0..1 per joint>]}]. '
      + 'Use only skills present in the catalog. No prose.';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, system: sys,
        messages: [{ role: 'user', content: `GOAL: ${goal}\nCATALOG: ${JSON.stringify(catalog)}` }] }),
    });
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || '').join('');
    const j = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    return JSON.parse(j);   // the plan is still routed through both guards above — the model is untrusted.
  };
}
