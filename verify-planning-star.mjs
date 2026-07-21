// verify-planning-star.mjs — RRT* (asymptotically-optimal planning). Same safety guarantees as RRT (every
// config + edge collision-free) but a SHORTER path, via best-parent selection + rewiring. Proven in 2D and
// 3D: RRT* returns a valid path substantially shorter than plain RRT on the same problem, and is
// deterministic. Honest scope: asymptotically optimal (more iterations → shorter), not a guarantee of the
// global optimum at finite iterations, and — like RRT — probabilistically complete (a given seed may fail).
//   node v2/skillpack/verify-planning-star.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPath, planOptimal, edgeClear } from './planning.mjs';
import { collides } from './collision.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;
const valid = (robot, p) => p.every((q) => !collides(robot, q).hit) && p.slice(1).every((q, i) => edgeClear(robot, p[i], q));

const planar = JSON.parse(await readFile(join(HERE, 'robots/planar-3r.json'), 'utf8'));
const spatial = JSON.parse(await readFile(join(HERE, 'robots/spatial-3r.json'), 'utf8'));

// ── 1 · RRT* finds a valid, shorter path than RRT (2D) ─────────────────────────────────────────────────
console.log(h('1 · RRT* returns a valid path, shorter than plain RRT (2D)'));
const S2 = [0.55, 0.48, 0.5], G2 = [0.6, 0.62, 0.5];
const rrt2 = planPath(planar, S2, G2, { seed: 7 });
const star2 = planOptimal(planar, S2, G2, { seed: 7 });
check('RRT* found a path', star2.found, `${star2.waypoints} waypoints, ${star2.nodes} nodes`);
check('every configuration and edge on the RRT* path is collision-free', star2.found && valid(planar, star2.path));
check('the RRT* path is substantially shorter than RRT (raw tree path)', star2.found && rrt2.found && star2.rawLength < rrt2.rawLength, `RRT* ${star2.rawLength.toFixed(2)} < RRT ${rrt2.rawLength.toFixed(2)}`);
check('even after smoothing both, RRT* is no longer than RRT', star2.cost <= rrt2.cost + 1e-9, `RRT* ${star2.cost.toFixed(2)} ≤ RRT ${rrt2.cost.toFixed(2)}`);

// ── 2 · determinism ────────────────────────────────────────────────────────────────────────────────────
console.log(h('2 · plans are reproducible'));
check('same seed → identical RRT* path', JSON.stringify(planOptimal(planar, S2, G2, { seed: 7 }).path) === JSON.stringify(star2.path));

// ── 3 · dimension-agnostic: RRT* works in 3D too ───────────────────────────────────────────────────────
console.log(h('3 · RRT* is dimension-agnostic (3D)'));
const S3 = [0.4, 0.15, 0.5], G3 = [0.6, 0.25, 0.5];
const rrt3 = planPath(spatial, S3, G3, { seed: 7 });
const star3 = planOptimal(spatial, S3, G3, { seed: 7 });
check('RRT* found a valid 3D path', star3.found && valid(spatial, star3.path), `${star3.waypoints} waypoints`);
check('the 3D RRT* path is shorter than RRT', star3.found && rrt3.found && star3.rawLength < rrt3.rawLength, `RRT* ${star3.rawLength.toFixed(2)} < RRT ${rrt3.rawLength.toFixed(2)}`);

// ── 4 · honest failure modes (same as RRT) ─────────────────────────────────────────────────────────────
console.log(h('4 · honest failure modes'));
check('a goal in collision is refused', !planOptimal(planar, S2, [0.55, 0.55, 0.5], { seed: 1 }).found);
check('a robot without geometry is refused', !planOptimal(JSON.parse(await readFile(join(HERE, 'robots/so101.json'), 'utf8')), [0.5, 0.5, 0.5, 0.5, 0.5], [0.6, 0.6, 0.6, 0.6, 0.6], { seed: 1 }).found);

console.log(h(fails === 0
  ? '✅ RRT* verified — asymptotically-optimal planning: same safety, shorter paths, in 2D and 3D'
  : `❌ ${fails} RRT* check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
