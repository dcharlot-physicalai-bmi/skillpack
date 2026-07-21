// collision — the geometry layer the safety case (SAFETY.md, N2) names as out of scope for the bare
// envelope. The envelope bounds each joint INDEPENDENTLY and models no geometry, so it permits colliding
// in-range configurations. This adds an OPTIONAL guard for robots that declare a geometry model: minimal
// planar forward kinematics, self-collision (non-adjacent link segments), floor, and keep-out boxes — and
// a protective-stop guard that halts BEFORE a command would enter a colliding configuration.
//
// It is layered ON TOP of the envelope, not instead of it: the envelope still bounds per-joint range/rate;
// this refuses the subset of in-range configs that are geometrically unsafe. Robots WITHOUT a geometry
// model get no collision guarantee (N2 stays honestly out of scope for them) — hasGeometry() says so.

export const hasGeometry = (robot) => !!(robot.geometry && robot.geometry.kind === 'planar-serial');

// normalized q[i] in [0,1] → cumulative planar joint angles → world points p0..pn (base + each joint/end).
export function forwardK(robot, q) {
  const g = robot.geometry;
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

// ── geometry helpers ────────────────────────────────────────────────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const clamp01 = (t) => Math.max(0, Math.min(1, t));

// shortest distance between segment ab and segment cd (2D).
function segSegDist(a, b, c, d) {
  const d1 = sub(b, a), d2 = sub(d, c), r = sub(a, c);
  const A = dot(d1, d1), E = dot(d2, d2), F = dot(d2, r);
  let s, t;
  if (A <= 1e-12 && E <= 1e-12) return Math.hypot(r[0], r[1]);
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
  const p1 = [a[0] + d1[0] * s, a[1] + d1[1] * s], p2 = [c[0] + d2[0] * t, c[1] + d2[1] * t];
  return Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
}

const inBox = (p, [xmin, ymin, xmax, ymax]) => p[0] >= xmin && p[0] <= xmax && p[1] >= ymin && p[1] <= ymax;

// does segment ab intersect axis-aligned box? endpoints inside, or crosses any edge.
function segBox(a, b, box) {
  if (inBox(a, box) || inBox(b, box)) return true;
  const [xmin, ymin, xmax, ymax] = box;
  const edges = [[[xmin, ymin], [xmax, ymin]], [[xmax, ymin], [xmax, ymax]], [[xmax, ymax], [xmin, ymax]], [[xmin, ymax], [xmin, ymin]]];
  const ccw = (A, B, C) => (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0]);
  const cross = (A, B, C, D) => ccw(A, C, D) !== ccw(B, C, D) && ccw(A, B, C) !== ccw(A, B, D);
  return edges.some(([c, d]) => cross(a, b, c, d));
}

// Is configuration q geometrically unsafe? → { hit, kind, detail }. Requires a geometry model.
export function collides(robot, q) {
  if (!hasGeometry(robot)) return { hit: false, kind: null, detail: 'no geometry model — collision checking not available (N2)' };
  const g = robot.geometry, pts = forwardK(robot, q);
  const seg = (i) => [pts[i], pts[i + 1]];
  const n = g.links.length;

  // self-collision: any pair of NON-ADJACENT link segments closer than the sum of their radii.
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    const dmin = segSegDist(pts[i], pts[i + 1], pts[j], pts[j + 1]);
    if (dmin < g.links[i].radius + g.links[j].radius) return { hit: true, kind: 'self-collision', detail: `link ${i} ∩ link ${j} (gap ${dmin.toFixed(3)})` };
  }
  const ws = g.workspace || {};
  // floor: any point below the floor plane.
  if (ws.floor_y != null) { const below = pts.find((p) => p[1] < ws.floor_y); if (below) return { hit: true, kind: 'floor', detail: `point y=${below[1].toFixed(3)} < floor ${ws.floor_y}` }; }
  // keep-out: any link segment intersecting a forbidden box.
  for (const k of ws.keepout || []) for (let i = 0; i < n; i++) if (segBox(pts[i], pts[i + 1], k.box)) return { hit: true, kind: 'keepout', detail: `link ${i} enters keep-out ${JSON.stringify(k.box)}` };
  return { hit: false, kind: null, detail: 'clear' };
}

// A protective-stop guard: given the last SAFE (collision-free) config and a proposed next config (already
// envelope-bounded), return what to actually command. If the proposal would collide, HOLD the last safe
// config (a protective stop) rather than moving into the collision.
export function collisionGuard(robot) {
  let lastSafe = null;
  return {
    available: hasGeometry(robot),
    // returns { command, halted, reason }
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
