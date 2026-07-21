// verify-collision-3d.mjs — the geometry + planning layers generalize from 2D to 3D. The collision layer
// gains a spatial (3D) forward-kinematic chain and 3D self-collision / floor / AABB keep-out checks; the
// RRT planner is UNCHANGED (it plans in normalized joint space via collides()/edgeClear()), so it solves
// the 3D problem for free. Proven on a didactic 3D 3R arm.
//   node v2/skillpack/verify-collision-3d.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardK, collides, collisionGuard, hasGeometry } from './collision.mjs';
import { planPath, edgeClear } from './planning.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

const robot = JSON.parse(await readFile(join(HERE, 'robots/spatial-3r.json'), 'utf8'));

// ── 1 · 3D forward kinematics ─────────────────────────────────────────────────────────────────────────
console.log(h('1 · 3D forward kinematics (rotation-per-joint about a declared axis)'));
check('robot declares a spatial (3D) geometry model', hasGeometry(robot) && robot.geometry.kind === 'spatial-serial');
const straight = forwardK(robot, [0.5, 0.5, 0.5]);   // all mid-range angles = 0 → straight along +x
check('zero-angle config extends along +x to the summed link length', near(straight[3][0], 0.4 + 0.35 + 0.25) && near(straight[3][1], 0) && near(straight[3][2], 0), `end = [${straight[3].map((v) => v.toFixed(2))}]`);
const yaw = forwardK(robot, [0.75, 0.5, 0.5]);       // base yaw +90° → along +y
check('a +90° base yaw rotates the arm into +y (a genuinely 3D transform)', near(yaw[3][0], 0, 1e-3) && near(yaw[3][1], 1.0, 1e-3), `end = [${yaw[3].map((v) => v.toFixed(2))}]`);
check('every point is 3-dimensional', straight.every((p) => p.length === 3));

// ── 2 · 3D collision detection ────────────────────────────────────────────────────────────────────────
console.log(h('2 · 3D self-collision, floor (z-plane), and AABB keep-out'));
check('a folded config is flagged as self-collision', collides(robot, [0.5, 1.0, 1.0]).kind === 'self-collision');
check('a config below the z-floor is flagged', collides(robot, [0.5, 0.8, 0.8]).kind === 'floor');
check('a config entering the 3D AABB keep-out is flagged', collides(robot, [0.5, 0.2, 0.5]).kind === 'keepout');
check('a clear config is not flagged', collides(robot, [0.5, 0.5, 0.5]).hit === false);

// ── 3 · the SAME planner solves the 3D problem (dimension-agnostic) ─────────────────────────────────────
console.log(h('3 · the unchanged RRT planner finds a collision-free 3D path'));
const START = [0.4, 0.15, 0.5], GOAL = [0.6, 0.25, 0.5];
check('start & goal are clear, but the straight 3D move collides', !collides(robot, START).hit && !collides(robot, GOAL).hit && !edgeClear(robot, START, GOAL));
const plan = planPath(robot, START, GOAL, { seed: 3 });
check('a 3D path was found', plan.found, `${plan.waypoints} waypoints, ${plan.nodes} nodes`);
check('every configuration on the 3D path is collision-free', plan.found && plan.path.every((q) => !collides(robot, q).hit));
check('every edge on the 3D path is collision-free', plan.found && plan.path.slice(1).every((q, i) => edgeClear(robot, plan.path[i], q)));
check('the 3D plan is deterministic (same seed → same path)', JSON.stringify(planPath(robot, START, GOAL, { seed: 3 }).path) === JSON.stringify(plan.path));

// ── 4 · the protective-stop guard works in 3D ──────────────────────────────────────────────────────────
console.log(h('4 · the protective-stop guard, in 3D'));
const guard = collisionGuard(robot);
let prev = [0.5, 0.5, 0.5], halted = false, everCollided = false;
for (let k = 0; k < 30; k++) {                       // drive toward a config that enters the keep-out
  const next = prev.map((p, i) => p + (([0.5, 0.2, 0.5][i]) - p) * 0.3);
  const g = guard.step(prev, next);
  if (collides(robot, g.command).hit) everCollided = true;
  if (g.halted) halted = true;
  prev = g.command;
}
check('the 3D guard halts before entering the keep-out', halted);
check('no commanded 3D config ever collided', !everCollided);

console.log(h(fails === 0
  ? '✅ 3D verified — collision + protective stop generalize to 3D, and the RRT planner solves 3D unchanged'
  : `❌ ${fails} 3D check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
