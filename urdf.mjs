// urdf — import a real robot's kinematics from URDF (the ROS-standard robot description) into a skillpack
// geometry model, so the collision + planning layers work on ACTUAL robots, not just didactic ones.
//
// Scope, stated honestly (a minimal, dependency-free importer — no XML library):
//   • Parses the kinematic chain: revolute / continuous / fixed joints with origin (xyz + rpy), axis, limits.
//   • Reads PRIMITIVE collision geometry (cylinder / sphere / box) for a conservative capsule radius.
//   • MESH collision geometry is NOT interpreted — it is reported in `warnings` (approximate or supply
//     primitive <collision> geometry). Ros/xacro macros must be expanded first (plain URDF only).
// The result is a `spatial-serial` geometry with a single conservative `uniformRadius` (= max link radius),
// which errs toward flagging collisions (the safe direction). This is not a full mesh collision importer.

// ── a tiny, tolerant XML reader for the URDF subset we need (elements + attributes; no entities/CDATA) ──
const attrs = (s) => { const o = {}; for (const m of s.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = m[2]; return o; };
// all <tag ...>inner</tag> and self-closing <tag .../> occurrences (non-nested-same-tag; fine for URDF).
function tags(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(\\s[^>]*?)?(/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  for (const m of xml.matchAll(re)) out.push({ attrs: attrs(m[1] || ''), inner: m[3] || '' });
  return out;
}
const nums = (s) => (s || '').trim().split(/\s+/).map(Number);

export function parseURDF(xml) {
  const robot = tags(xml, 'robot')[0] || { attrs: {}, inner: xml };
  const links = {};
  for (const l of tags(robot.inner, 'link')) {
    const col = tags(l.inner, 'collision')[0];
    let radius = null, length = null;
    if (col) {
      const g = tags(col.inner, 'geometry')[0];
      if (g) {
        const cyl = tags(g.inner, 'cylinder')[0], sph = tags(g.inner, 'sphere')[0], box = tags(g.inner, 'box')[0], mesh = tags(g.inner, 'mesh')[0];
        if (cyl) { radius = Number(cyl.attrs.radius); length = Number(cyl.attrs.length); }
        else if (sph) { radius = Number(sph.attrs.radius); length = 2 * radius; }
        else if (box) { const [x, y, z] = nums(box.attrs.size); radius = Math.hypot(x, y, z) / 2; length = Math.max(x, y, z); }
        else if (mesh) radius = 'mesh';
      }
    }
    links[l.attrs.name] = { radius, length };
  }
  const joints = tags(robot.inner, 'joint').map((j) => {
    const origin = tags(j.inner, 'origin')[0], axis = tags(j.inner, 'axis')[0], limit = tags(j.inner, 'limit')[0];
    const parent = tags(j.inner, 'parent')[0], child = tags(j.inner, 'child')[0];
    return {
      name: j.attrs.name, type: j.attrs.type,
      parent: parent && parent.attrs.link, child: child && child.attrs.link,
      origin: { xyz: origin ? nums(origin.attrs.xyz || '0 0 0') : [0, 0, 0], rpy: origin ? nums(origin.attrs.rpy || '0 0 0') : [0, 0, 0] },
      axis: axis ? nums(axis.attrs.xyz) : [0, 0, 1],
      limit: limit ? { lower: Number(limit.attrs.lower), upper: Number(limit.attrs.upper) } : null,
    };
  });
  return { name: robot.attrs.name, links, joints };
}

// Convert a parsed URDF into a skillpack `spatial-serial` geometry, walking the chain from the root link.
export function urdfToGeometry(urdf) {
  const warnings = [];
  const childLinks = new Set(urdf.joints.map((j) => j.child));
  const root = Object.keys(urdf.links).find((n) => !childLinks.has(n));
  const byParent = new Map(urdf.joints.map((j) => [j.parent, j]));

  const chain = [];
  let cur = root;
  while (byParent.has(cur)) { const j = byParent.get(cur); chain.push(j); cur = j.child; }
  if (chain.length === 0) throw new Error('URDF has no kinematic chain from the root link');

  const MOVABLE = new Set(['revolute', 'continuous']);
  const radii = Object.values(urdf.links).map((l) => l.radius).filter((r) => typeof r === 'number');
  if (Object.values(urdf.links).some((l) => l.radius === 'mesh')) warnings.push('mesh collision geometry is not interpreted; using a conservative uniform radius from primitive links only');
  const uniformRadius = radii.length ? Math.max(...radii) : 0.05;

  const joints = [];
  let lastChild = root;
  for (const j of chain) {
    if (j.type === 'fixed') { warnings.push(`fixed joint "${j.name}" is not yet merged into the chain (v1 supports revolute/continuous)`); continue; }
    if (!MOVABLE.has(j.type)) { warnings.push(`joint "${j.name}" type "${j.type}" unsupported; skipped`); continue; }
    const lim = j.limit || { lower: -Math.PI, upper: Math.PI };   // continuous joints have no limit → full turn
    joints.push({ name: j.name, origin: j.origin, axis: j.axis, range: [lim.lower, lim.upper] });
    lastChild = j.child;
  }
  // the last link has no downstream joint; extend the tip by its own collision length along the joint's local x.
  const tipLen = (urdf.links[lastChild] && urdf.links[lastChild].length) || uniformRadius * 2;
  const tip = { xyz: [tipLen, 0, 0], radius: uniformRadius };

  return {
    geometry: { kind: 'spatial-serial', base: [0, 0, 0], uniformRadius, joints, tip },
    dof: joints.length, warnings,
  };
}

// Build a full skillpack robot manifest from URDF text.
export function robotFromURDF(xml, { name, morphology = 'arm', actuation = 'position' } = {}) {
  const urdf = parseURDF(xml);
  const { geometry, dof, warnings } = urdfToGeometry(urdf);
  return {
    robot: { name: name || urdf.name || 'urdf-robot', morphology, dof, actuation, sensors: ['proprioception', 'target_pose'], joint_ids: Array.from({ length: dof }, (_, i) => i + 1), driver: { target: 'feetech' }, geometry },
    warnings,
  };
}
