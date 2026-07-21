// collision — the geometry layer the safety case (SAFETY.md, N2) names as out of scope for the bare
// envelope. The envelope bounds each joint INDEPENDENTLY and models no geometry, so it permits colliding
// in-range configurations. This adds an OPTIONAL guard for robots that declare a geometry model: forward
// kinematics, self-collision (non-adjacent link capsules), floor, and keep-out boxes — and a protective-stop
// guard that halts BEFORE a command would enter a colliding configuration.
//
// Two geometry kinds share one set of checks (the distance math is dimension-generic):
//   • "planar-serial"  — 2D chain: joint angles accumulate in the plane. Floor = min y; keep-out = 2D box.
//   • "spatial-serial" — 3D chain: each joint rotates about a declared axis, then a link offset. Floor =
//                        min z; keep-out = 3D AABB. The RRT planner (planning.mjs) is unchanged — it plans
//                        in normalized joint space via collides()/edgeClear(), so 3D works for free.
//
// Layered ON TOP of the envelope, not instead of it. Robots WITHOUT a geometry model get no collision
// guarantee (N2 stays honestly out of scope) — hasGeometry() says so. Capsule/AABB, not full mesh.

export const hasGeometry = (robot) => !!(robot.geometry && ['planar-serial', 'spatial-serial'].includes(robot.geometry.kind));

// ── dimension-generic vector helpers (work for 2D or 3D arrays) ──────────────────────────────────────
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a) => Math.sqrt(dot(a, a));
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (a, s) => a.map((v) => v * s);
const clamp01 = (t) => Math.max(0, Math.min(1, t));

// shortest distance between segment ab and segment cd (any dimension).
function segSegDist(a, b, c, d) {
  const d1 = sub(b, a), d2 = sub(d, c), r = sub(a, c);
  const A = dot(d1, d1), E = dot(d2, d2), F = dot(d2, r);
  let s, t;
  if (A <= 1e-12 && E <= 1e-12) return norm(r);
  if (A <= 1e-12) { s = 0; t = clamp01(F / E); }
  else {
    const C = dot(d1, r);
    if (E <= 1e-12) { t = 0; s = clamp01(-C / A); }
    else {
      const B = dot(d1, d2), den = A * E - B * B;
      s = den > 1e-12 ? clamp01((B * F - C * E) / den) : 0;
      t = (B * s + F) / E;
      if (t < 0) { t = 0; s = clamp01(-C / A); } else if (t > 1) { t = 1; s = clamp01((B - C) / A); }
    }
  }
  return norm(sub(add(a, scale(d1, s)), add(c, scale(d2, t))));
}

// ── 2D planar forward kinematics ──────────────────────────────────────────────────────────────────────
function planarFK(g, q) {
  const pts = [g.base.slice()];
  let ang = 0;
  for (let i = 0; i < g.links.length; i++) {
    const [lo, hi] = g.joint_range_rad[i];
    ang += lo + (q[i] ?? 0.5) * (hi - lo);
    const p = pts[pts.length - 1];
    pts.push([p[0] + g.links[i].length * Math.cos(ang), p[1] + g.links[i].length * Math.sin(ang)]);
  }
  return pts;
}

// ── 3D spatial forward kinematics (Rodrigues rotation per joint, then a link offset) ───────────────────
function rotAxis(axis, ang) {
  const n = norm(axis) || 1, [x, y, z] = axis.map((v) => v / n);
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}
const matmul3 = (A, B) => A.map((row) => B[0].map((_, j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
const matvec3 = (M, v) => M.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

function spatialFK(g, q) {
  let R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], p = g.base.slice();
  const pts = [p.slice()];
  for (let i = 0; i < g.joints.length; i++) {
    const [lo, hi] = g.joint_range_rad[i];
    R = matmul3(R, rotAxis(g.joints[i].axis, lo + (q[i] ?? 0.5) * (hi - lo)));
    p = add(p, matvec3(R, g.joints[i].link));
    pts.push(p.slice());
  }
  return pts;
}

export function forwardK(robot, q) {
  const g = robot.geometry;
  return g.kind === 'spatial-serial' ? spatialFK(g, q) : planarFK(g, q);
}

const radiusOf = (g, i) => (g.links ? g.links[i].radius : g.joints[i].radius);
const nLinks = (g) => (g.links ? g.links.length : g.joints.length);

// ── keep-out tests ──────────────────────────────────────────────────────────────────────────────────
const inBox2 = (p, [xmin, ymin, xmax, ymax]) => p[0] >= xmin && p[0] <= xmax && p[1] >= ymin && p[1] <= ymax;
function segBox2(a, b, box) {
  if (inBox2(a, box) || inBox2(b, box)) return true;
  const [xmin, ymin, xmax, ymax] = box;
  const edges = [[[xmin, ymin], [xmax, ymin]], [[xmax, ymin], [xmax, ymax]], [[xmax, ymax], [xmin, ymax]], [[xmin, ymax], [xmin, ymin]]];
  const ccw = (A, B, C) => (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0]);
  const cross = (A, B, C, D) => ccw(A, C, D) !== ccw(B, C, D) && ccw(A, B, C) !== ccw(A, B, D);
  return edges.some(([c, d]) => cross(a, b, c, d));
}
// segment vs 3D AABB via slab clipping. aabb = [xmin,ymin,zmin,xmax,ymax,zmax].
function segAABB3(a, b, aabb) {
  const min = aabb.slice(0, 3), max = aabb.slice(3, 6), d = sub(b, a);
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) { if (a[i] < min[i] || a[i] > max[i]) return false; }
    else {
      let ta = (min[i] - a[i]) / d[i], tb = (max[i] - a[i]) / d[i];
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
  }
  return true;
}

// Is configuration q geometrically unsafe? → { hit, kind, detail }. Requires a geometry model.
export function collides(robot, q) {
  if (!hasGeometry(robot)) return { hit: false, kind: null, detail: 'no geometry model — collision checking not available (N2)' };
  const g = robot.geometry, pts = forwardK(robot, q), n = nLinks(g), spatial = g.kind === 'spatial-serial';

  // self-collision: any pair of NON-ADJACENT link capsules closer than the sum of their radii.
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    const dmin = segSegDist(pts[i], pts[i + 1], pts[j], pts[j + 1]);
    if (dmin < radiusOf(g, i) + radiusOf(g, j)) return { hit: true, kind: 'self-collision', detail: `link ${i} ∩ link ${j} (gap ${dmin.toFixed(3)})` };
  }
  const ws = g.workspace || {};
  // floor: the vertical axis is y in 2D, z in 3D.
  const vAxis = spatial ? 2 : 1, floor = spatial ? ws.floor_z : ws.floor_y;
  if (floor != null) { const below = pts.find((p) => p[vAxis] < floor); if (below) return { hit: true, kind: 'floor', detail: `point ${['x', 'y', 'z'][vAxis]}=${below[vAxis].toFixed(3)} < floor ${floor}` }; }
  // keep-out: any link segment intersecting a forbidden region (2D box or 3D AABB).
  for (const k of ws.keepout || []) for (let i = 0; i < n; i++) {
    const hit = spatial ? segAABB3(pts[i], pts[i + 1], k.aabb) : segBox2(pts[i], pts[i + 1], k.box);
    if (hit) return { hit: true, kind: 'keepout', detail: `link ${i} enters keep-out ${JSON.stringify(k.aabb || k.box)}` };
  }
  return { hit: false, kind: null, detail: 'clear' };
}

// A protective-stop guard: given the last SAFE (collision-free) config and a proposed next config (already
// envelope-bounded), return what to actually command. If the proposal would collide, HOLD the last safe
// config (a protective stop) rather than moving into the collision.
export function collisionGuard(robot) {
  let lastSafe = null;
  return {
    available: hasGeometry(robot),
    step(prevConfig, proposedConfig) {
      if (!hasGeometry(robot)) return { command: proposedConfig, halted: false, reason: 'no geometry model' };
      if (lastSafe == null) lastSafe = collides(robot, prevConfig).hit ? proposedConfig.slice() : prevConfig.slice();
      const c = collides(robot, proposedConfig);
      if (c.hit) return { command: lastSafe.slice(), halted: true, reason: `${c.kind}: ${c.detail}` };
      lastSafe = proposedConfig.slice();
      return { command: proposedConfig.slice(), halted: false, reason: 'clear' };
    },
  };
}
