// planning — the layer the collision work names next: not just HALT at an obstacle (the protective stop in
// collision.mjs), but PLAN a collision-free path around it. A seeded RRT with goal-biasing in normalized
// joint space, using the geometry collision checker for both node and edge validity, plus greedy shortcut
// smoothing. Deterministic (seeded PRNG), so a plan is reproducible and testable.
//
// Scope, stated honestly: this plans in the same 2D planar joint space the collision layer models; it is a
// GUARANTEED-SAFE path (every config and every edge is collision-free) but NOT a shortest/optimal one, and
// it inherits collision.mjs's limits (2D, declared geometry only). It requires a geometry model.

import { collides, hasGeometry } from './collision.mjs';

const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

// a small deterministic PRNG so plans are reproducible (no Math.random)
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Is the straight segment a→b collision-free? (checks configs at `res` resolution along the edge.)
export function edgeClear(robot, a, b, res = 0.02) {
  const n = Math.max(1, Math.ceil(dist(a, b) / res));
  for (let k = 0; k <= n; k++) {
    const t = k / n, c = a.map((v, i) => v + (b[i] - v) * t);
    if (collides(robot, c).hit) return false;
  }
  return true;
}

export const pathLength = (path) => path.slice(1).reduce((s, q, i) => s + dist(path[i], q), 0);

// greedy shortcutting: repeatedly try to splice out waypoints by connecting a pair directly if the edge is clear.
function shortcut(robot, path, res, rnd) {
  let p = path.slice();
  for (let k = 0; k < 300 && p.length > 2; k++) {
    const i = Math.floor(rnd() * (p.length - 2));
    const j = i + 2 + Math.floor(rnd() * (p.length - i - 2));
    if (j < p.length && edgeClear(robot, p[i], p[j], res)) p = p.slice(0, i + 1).concat(p.slice(j));
  }
  return p;
}

// Plan a collision-free path from start to goal (normalized joint configs). Returns { found, path, ... }.
export function planPath(robot, start, goal, opts = {}) {
  const { seed = 1, maxIter = 6000, eps = 0.05, goalBias = 0.1, res = 0.02, tol = 0.04 } = opts;
  if (!hasGeometry(robot)) return { found: false, reason: 'no geometry model — planning requires geometry', path: null };
  if (collides(robot, start).hit) return { found: false, reason: 'start in collision', path: null };
  if (collides(robot, goal).hit) return { found: false, reason: 'goal in collision', path: null };

  const dof = start.length, rnd = mulberry32(seed);
  const nodes = [{ q: start.slice(), parent: -1 }];
  const sample = () => (rnd() < goalBias ? goal.slice() : Array.from({ length: dof }, () => rnd()));
  const nearest = (q) => { let bi = 0, bd = Infinity; for (let i = 0; i < nodes.length; i++) { const d = dist(nodes[i].q, q); if (d < bd) { bd = d; bi = i; } } return bi; };

  for (let it = 0; it < maxIter; it++) {
    const qr = sample(), ni = nearest(qr), qn = nodes[ni].q;
    const d = dist(qn, qr), step = Math.min(1, eps / (d || 1));
    const qnew = qn.map((v, i) => Math.max(0, Math.min(1, v + (qr[i] - v) * step)));
    if (collides(robot, qnew).hit || !edgeClear(robot, qn, qnew, res)) continue;
    nodes.push({ q: qnew, parent: ni });
    if (dist(qnew, goal) < tol && edgeClear(robot, qnew, goal, res)) {
      nodes.push({ q: goal.slice(), parent: nodes.length - 1 });
      let path = [], idx = nodes.length - 1;
      while (idx >= 0) { path.push(nodes[idx].q); idx = nodes[idx].parent; }
      path.reverse();
      const smoothed = shortcut(robot, path, res, rnd);
      return { found: true, path: smoothed, rawWaypoints: path.length, waypoints: smoothed.length, nodes: nodes.length, iterations: it + 1 };
    }
  }
  return { found: false, reason: 'max iterations reached', path: null, nodes: nodes.length };
}
