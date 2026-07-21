// verify-gjk.mjs — convex collision via GJK (the last named geometry frontier). Two parts: (1) the GJK
// distance routine is correct on analytic cases (vertex/edge/face/penetration/interior), and (2) it powers
// arbitrary CONVEX-HULL keep-out volumes in the collision layer — not just axis-aligned boxes — so
// collision + planning handle angled fixtures. Scope, honestly: CONVEX hulls only; a concave mesh must be
// decomposed into convex pieces first.
//   node v2/skillpack/verify-gjk.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gjkDistance, gjkIntersect } from './gjk.mjs';
import { collides } from './collision.mjs';
import { planOptimal, edgeClear } from './planning.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;
const box = (x0, y0, z0, x1, y1, z1) => [[x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0], [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1]];
const near = (a, b, e = 1e-4) => Math.abs(a - b) < e;

// ── 1 · GJK distance is correct on analytic cases ──────────────────────────────────────────────────────
console.log(h('1 · GJK distance matches analytic geometry'));
const A = box(0, 0, 0, 1, 1, 1);
check('separated boxes → the gap distance', near(gjkDistance(A, box(2, 0, 0, 3, 1, 1)), 1));
check('overlapping boxes → 0', near(gjkDistance(A, box(0.5, 0.5, 0.5, 1.5, 1.5, 1.5)), 0));
check('face-touching boxes → 0', near(gjkDistance(A, box(1, 0, 0, 2, 1, 1)), 0));
check('a point outside → point-to-box distance', near(gjkDistance(A, [[3, 0, 0]]), 2));
check('a point inside → 0', near(gjkDistance(A, [[0.5, 0.5, 0.5]]), 0));
check('diagonal gap → √3', near(gjkDistance(A, box(2, 2, 2, 3, 3, 3)), Math.sqrt(3)));
check('a segment vs the box → nearest-approach distance', near(gjkDistance(A, [[3, 0.5, 0.5], [3, 2, 0.5]]), 2));
check('gjkIntersect margin respects the radius', gjkIntersect(A, [[1.05, 0.5, 0.5]], 0.1) && !gjkIntersect(A, [[1.2, 0.5, 0.5]], 0.1));

// ── 2 · convex-hull keep-out volumes in the collision layer ────────────────────────────────────────────
console.log(h('2 · an arbitrary convex-hull keep-out (a diamond), not an axis-aligned box'));
const robot = JSON.parse(await readFile(join(HERE, 'robots/planar-3r.json'), 'utf8'));
const diamond = [[0.6, 0.35, -0.1], [0.8, 0.55, -0.1], [0.6, 0.75, -0.1], [0.4, 0.55, -0.1], [0.6, 0.35, 0.1], [0.8, 0.55, 0.1], [0.6, 0.75, 0.1], [0.4, 0.55, 0.1]];
robot.geometry.workspace = { floor_y: -10, keepout: [{ hull: diamond }] };
check('a config whose link enters the diamond hull is flagged (kind=keepout)', collides(robot, [0.6, 0.6, 0.5]).kind === 'keepout');
check('a config clear of the hull is not flagged', collides(robot, [0.5, 0.5, 0.5]).hit === false);

// ── 3 · planning routes around a convex-hull keep-out ──────────────────────────────────────────────────
console.log(h('3 · the planner routes around the convex-hull keep-out'));
const START = [0.55, 0.48, 0.5], GOAL = [0.62, 0.62, 0.5];
check('start & goal clear, but the straight-line move enters the hull', !collides(robot, START).hit && !collides(robot, GOAL).hit && !edgeClear(robot, START, GOAL));
const plan = planOptimal(robot, START, GOAL, { seed: 7 });
check('a collision-free path around the hull is found', plan.found && plan.path.every((q) => !collides(robot, q).hit) && plan.path.slice(1).every((q, i) => edgeClear(robot, plan.path[i], q)), `${plan.waypoints} waypoints`);

console.log(h(fails === 0
  ? '✅ GJK verified — correct convex distance, powering arbitrary convex-hull keep-outs for collision + planning'
  : `❌ ${fails} GJK check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
