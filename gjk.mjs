// gjk — Gilbert-Johnson-Keerthi distance between two CONVEX point sets (the last named geometry frontier:
// convex collision beyond capsule/AABB primitives). Returns the shortest distance between the convex hulls
// of A and B (0 if they intersect). 3D; 2D sets work by using z = 0. Used by collision.mjs for convex
// keep-out volumes and convex-hull links. Scope: CONVEX hulls only (a concave mesh must be decomposed into
// convex pieces first) — stated honestly, and this file is validated against analytic cases in verify-gjk.mjs.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const v3 = (p) => [p[0] || 0, p[1] || 0, p[2] || 0];

// support: farthest point of a convex set in direction d (the Minkowski support of A⊖B is supportA(d) − supportB(−d)).
function support(verts, d) {
  let best = verts[0], bd = -Infinity;
  for (const p of verts) { const s = dot(v3(p), d); if (s > bd) { bd = s; best = p; } }
  return v3(best);
}

// closest point to the ORIGIN on the simplex, returning { point, keep } where keep is the minimal subset of
// indices whose convex hull contains that closest point (Ericson RTCD closest-point routines, ref = origin).
function closestOnSimplex(s) {
  if (s.length === 1) return { point: s[0], keep: [0] };
  if (s.length === 2) return segClosest(s[0], s[1], [0, 1]);
  if (s.length === 3) return triClosest(s[0], s[1], s[2], [0, 1, 2]);
  return tetraClosest(s[0], s[1], s[2], s[3]);
}

function segClosest(a, b, idx) {
  const ab = sub(b, a), t = dot(scale(a, -1), ab);
  if (t <= 0) return { point: a, keep: [idx[0]] };
  const den = dot(ab, ab);
  if (t >= den) return { point: b, keep: [idx[1]] };
  return { point: addv(a, scale(ab, t / den)), keep: idx };
}

// closest point on triangle abc to the origin (Ericson, with p = origin).
function triClosest(a, b, c, idx) {
  const ab = sub(b, a), ac = sub(c, a), ap = scale(a, -1);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { point: a, keep: [idx[0]] };
  const bp = scale(b, -1), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { point: b, keep: [idx[1]] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); return { point: addv(a, scale(ab, t)), keep: [idx[0], idx[1]] }; }
  const cp = scale(c, -1), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { point: c, keep: [idx[2]] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); return { point: addv(a, scale(ac, t)), keep: [idx[0], idx[2]] }; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return { point: addv(b, scale(sub(c, b), t)), keep: [idx[1], idx[2]] }; }
  const den = 1 / (va + vb + vc), w = vb * den, u = vc * den;   // interior: barycentric
  return { point: addv(addv(a, scale(ab, w)), scale(ac, u)), keep: idx };
}

const triNormalSign = (a, b, c, ref) => dot(cross(sub(b, a), sub(c, a)), sub(ref, a));
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

// closest point on tetrahedron abcd to the origin: the closest among the faces the origin is "outside" of.
function tetraClosest(a, b, c, d) {
  let best = { point: a, keep: [0], d2: Infinity };
  const faces = [[a, b, c, d, [0, 1, 2]], [a, c, d, b, [0, 2, 3]], [a, d, b, c, [0, 3, 1]], [b, d, c, a, [1, 3, 2]]];
  let inside = true;
  for (const [p, q, r, opp, idx] of faces) {
    // origin and the opposite vertex must be on opposite sides of face pqr for the origin to be "outside" it
    const sOrigin = triNormalSign(p, q, r, [0, 0, 0]), sOpp = triNormalSign(p, q, r, opp);
    if (sOrigin === 0 || (sOrigin > 0) !== (sOpp > 0)) {
      inside = false;
      const t = triClosest(p, q, r, idx);
      const d2 = dot(t.point, t.point);
      if (d2 < best.d2) best = { point: t.point, keep: t.keep, d2 };
    }
  }
  if (inside) return { point: [0, 0, 0], keep: [0, 1, 2, 3] };   // origin inside tetra → intersecting
  return { point: best.point, keep: best.keep };
}

// Shortest distance between the convex hulls of A and B (0 if they intersect). A, B: arrays of points.
export function gjkDistance(A, B) {
  const EPS = 1e-10;
  const supD = (d) => sub(support(A, d), support(B, scale(d, -1)));
  let simplex = [supD([1, 0, 0])];
  let v = simplex[0];                             // current closest point of D to the origin
  for (let iter = 0; iter < 64; iter++) {
    const vv = dot(v, v);
    if (vv < EPS) return 0;                       // origin in D → intersecting
    const w = supD(scale(v, -1));                 // support toward the origin
    if (vv - dot(v, w) <= EPS * vv) return Math.sqrt(vv);   // v·v − v·w small → converged (no closer point)
    simplex.push(w);
    const r = closestOnSimplex(simplex);
    v = r.point;
    simplex = r.keep.map((i) => simplex[i]);
  }
  return Math.sqrt(dot(v, v));
}

export const gjkIntersect = (A, B, margin = 0) => gjkDistance(A, B) <= margin + 1e-9;
