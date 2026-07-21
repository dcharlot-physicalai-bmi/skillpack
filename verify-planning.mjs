// verify-planning.mjs — the motion-planning layer: go from HALT-at-the-obstacle (collision.mjs's protective
// stop) to PLAN-a-path-around-it. Proves: where a straight-line joint move would collide, the planner finds
// a collision-free path (every config AND every edge clear); the path connects start to goal; smoothing
// shrinks it while keeping it valid; plans are deterministic; and the payoff — executing the PLANNED path,
// the protective stop never trips and the goal is reached, whereas the straight line halts short.
//   node v2/skillpack/verify-planning.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPath, edgeClear, pathLength } from './planning.mjs';
import { collides, collisionGuard } from './collision.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const robot = JSON.parse(await readFile(join(HERE, 'robots/planar-3r.json'), 'utf8'));
const so101 = JSON.parse(await readFile(join(HERE, 'robots/so101.json'), 'utf8'));
const START = [0.55, 0.48, 0.5], GOAL = [0.6, 0.62, 0.5];   // both clear; the straight joint move collides

// ── 1 · the problem is real: the direct path collides ────────────────────────────────────────────────
console.log(h('1 · a straight-line joint move from start to goal would collide'));
check('start and goal are each collision-free', !collides(robot, START).hit && !collides(robot, GOAL).hit);
check('the straight-line interpolation between them is NOT clear (needs a detour)', !edgeClear(robot, START, GOAL));

// ── 2 · the planner finds a valid path ────────────────────────────────────────────────────────────────
console.log(h('2 · the planner finds a collision-free path around the obstacle'));
const plan = planPath(robot, START, GOAL, { seed: 7 });
check('a path was found', plan.found, `${plan.waypoints} waypoints, ${plan.nodes} nodes, ${plan.iterations} iters`);
check('every configuration on the path is collision-free', plan.path.every((q) => !collides(robot, q).hit));
check('every edge on the path is collision-free', plan.path.slice(1).every((q, i) => edgeClear(robot, plan.path[i], q)));
check('the path connects start to goal', pathLength([plan.path[0], START]) < 1e-9 && pathLength([plan.path[plan.path.length - 1], GOAL]) < 1e-9);
check('smoothing shrank the raw tree path but kept it valid', plan.waypoints <= plan.rawWaypoints, `${plan.rawWaypoints} → ${plan.waypoints} waypoints, length ${pathLength(plan.path).toFixed(2)}`);

// ── 3 · determinism ──────────────────────────────────────────────────────────────────────────────────
console.log(h('3 · plans are reproducible'));
check('same seed → identical path', JSON.stringify(planPath(robot, START, GOAL, { seed: 7 }).path) === JSON.stringify(plan.path));

// ── 4 · honesty — the planner refuses the impossible / unsupported ─────────────────────────────────────
console.log(h('4 · honest failure modes'));
const badGoal = planPath(robot, START, [0.55, 0.55, 0.5], { seed: 1 });   // goal is in the keep-out
check('a goal that is itself in collision is refused', !badGoal.found && /goal in collision/.test(badGoal.reason));
const noGeo = planPath(so101, [0.5, 0.5, 0.5, 0.5, 0.5], [0.6, 0.6, 0.6, 0.6, 0.6], { seed: 1 });
check('planning on a robot without geometry is refused', !noGeo.found && /no geometry/.test(noGeo.reason));

// ── 5 · the payoff — follow the PLANNED path vs the STRAIGHT line through the protective stop ───────────
console.log(h('5 · following the plan, the protective stop never trips and the goal is reached'));
const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
// Command the ideal trajectory (densely interpolated along the given waypoints) through the collision guard.
function driveThroughGuard(waypoints, res = 0.02) {
  const guard = collisionGuard(robot);
  const dense = [];
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i], n = Math.max(1, Math.ceil(dist(a, b) / res));
    for (let k = 1; k <= n; k++) { const t = k / n; dense.push(a.map((v, j) => v + (b[j] - v) * t)); }
  }
  let world = waypoints[0].slice(), halts = 0, collided = false;
  for (const cfg of dense) {
    const g = guard.step(world, cfg);
    if (g.halted) halts++;
    if (collides(robot, g.command).hit) collided = true;
    world = g.command;
  }
  return { halts, collided, reached: dist(world, waypoints[waypoints.length - 1]) < 0.05, world };
}
const planned = driveThroughGuard(plan.path);
check('planned path: goal reached', planned.reached);
check('planned path: the protective stop never had to halt (path is clear by construction)', planned.halts === 0);
check('planned path: no commanded config ever collided', !planned.collided);

const straight = driveThroughGuard([START, GOAL]);
check('contrast — the straight line repeatedly trips the protective stop (planning avoids the emergency halts)', straight.halts > 0 && planned.halts === 0, `straight: ${straight.halts} halts vs planned: ${planned.halts}`);
check('contrast — even so, no commanded config ever collided (the stop always held a safe config)', !straight.collided);

console.log(h(fails === 0
  ? '✅ planning verified — a collision-free path is found around the obstacle; following it avoids the protective halts the straight line triggers'
  : `❌ ${fails} planning check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
