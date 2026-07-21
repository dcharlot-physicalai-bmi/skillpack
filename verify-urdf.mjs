// verify-urdf.mjs — the geometry/collision/planning layer works on REAL robots via URDF import (the
// ROS-standard robot description), not just didactic ones. Proves: the parser reads the kinematic chain
// and primitive collision geometry; the derived geometry's forward kinematics matches hand computation;
// mesh geometry is honestly flagged (not silently wrong); and the full pipeline (import → collision →
// plan) runs on the imported robot.
//   node v2/skillpack/verify-urdf.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseURDF, robotFromURDF } from './urdf.mjs';
import { forwardK, collides, collisionGuard } from './collision.mjs';
import { planPath, edgeClear } from './planning.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

const xml = await readFile(join(HERE, 'examples/test-2r.urdf'), 'utf8');

// ── 1 · parse the kinematic chain + primitive collision geometry ────────────────────────────────────
console.log(h('1 · parse URDF (joints, axes, limits, collision primitives)'));
const urdf = parseURDF(xml);
check('two revolute joints parsed', urdf.joints.length === 2 && urdf.joints.every((j) => j.type === 'revolute'));
check('joint origins and axes read correctly', JSON.stringify(urdf.joints[1].origin.xyz) === '[0.4,0,0]' && JSON.stringify(urdf.joints[0].axis) === '[0,0,1]');
check('joint limits read correctly', near(urdf.joints[1].limit.upper, 2.61799) && near(urdf.joints[1].limit.lower, -2.61799));
check('primitive collision radii read from each link', urdf.links.base.radius === 0.05 && urdf.links.l1.radius === 0.04 && urdf.links.l2.radius === 0.03);

// ── 2 · derive a skillpack geometry + verify FK against hand computation ───────────────────────────────
console.log(h('2 · import → geometry, and FK matches hand computation'));
const { robot, warnings } = robotFromURDF(xml, { name: 'test2r' });
check('imported robot has the right DoF and a conservative uniform radius', robot.dof === 2 && robot.geometry.uniformRadius === 0.05, `dof=${robot.dof}, r=${robot.geometry.uniformRadius}`);
check('no warnings for an all-primitive URDF', warnings.length === 0);
const tipStraight = forwardK(robot, [0.5, 0.5]).at(-1);   // angles 0 → straight along +x, reach 0.4+0.3
check('straight config → tip at [0.7, 0, 0]', near(tipStraight[0], 0.7) && near(tipStraight[1], 0) && near(tipStraight[2], 0), `[${tipStraight.map((v) => v.toFixed(2))}]`);
const tipYaw = forwardK(robot, [0.75, 0.5]).at(-1);       // j1 +90° → tip into +y
check('base +90° yaw → tip at [0, 0.7, 0] (URDF origin transforms applied)', near(tipYaw[0], 0) && near(tipYaw[1], 0.7), `[${tipYaw.map((v) => v.toFixed(2))}]`);

// ── 3 · honesty — mesh geometry is flagged, not silently mis-imported ──────────────────────────────────
console.log(h('3 · honest handling of mesh geometry and unsupported joints'));
const meshXml = await readFile(join(HERE, 'examples/mesh-arm.urdf'), 'utf8');
const mesh = robotFromURDF(meshXml, { name: 'meshbot' });
check('mesh collision geometry produces a warning (not a silent wrong radius)', mesh.warnings.some((w) => /mesh/.test(w)));
check('the conservative radius falls back to the primitive links only', mesh.robot.geometry.uniformRadius === 0.06);
check('a continuous joint (no <limit>) imports with a full-turn range', mesh.robot.geometry.joints[0].range[0] < -3 && mesh.robot.geometry.joints[0].range[1] > 3);

// ── 3b · fixed-joint merging (tool mounts / sensor frames / base offsets are preserved) ────────────────
console.log(h('3b · fixed joints are merged (their transform is preserved, not dropped)'));
const fixedXml = await readFile(join(HERE, 'examples/test-fixed.urdf'), 'utf8');
const fixed = robotFromURDF(fixedXml, { name: 'fixedbot' });
check('the fixed joint is folded in (2 movable DoF, no "unsupported" warning)', fixed.robot.dof === 2 && fixed.warnings.length === 0);
check('the merged origin carries a raw rotation matrix + composed translation', !!fixed.robot.geometry.joints[1].origin.R && JSON.stringify(fixed.robot.geometry.joints[1].origin.xyz.map((v) => +v.toFixed(3))) === '[0.4,0.2,0]');
const fixedTip = forwardK(fixed.robot, [0.5, 0.5]).at(-1);   // hand calc: fixed 90° yaw rotates l2 into +y
check('FK matches hand computation through the fixed 90° rotation → tip [0.4, 0.5, 0]', near(fixedTip[0], 0.4) && near(fixedTip[1], 0.5) && near(fixedTip[2], 0), `[${fixedTip.map((v) => v.toFixed(2))}]`);

// ── 4 · the full pipeline runs on the imported robot ───────────────────────────────────────────────────
console.log(h('4 · collision + planning on the imported robot (with a configured keep-out)'));
robot.geometry.workspace = { floor_z: -10, keepout: [{ aabb: [0.55, -0.12, -0.1, 0.85, 0.12, 0.1] }] };
const START = [0.6, 0.55], GOAL = [0.4, 0.55];
check('start & goal clear, straight-line move collides with the keep-out', !collides(robot, START).hit && !collides(robot, GOAL).hit && !edgeClear(robot, START, GOAL));
const plan = planPath(robot, START, GOAL, { seed: 5 });
check('the planner finds a collision-free path on the imported robot', plan.found && plan.path.every((q) => !collides(robot, q).hit) && plan.path.slice(1).every((q, i) => edgeClear(robot, plan.path[i], q)), `${plan.waypoints} waypoints`);
// the protective-stop guard works on the imported robot too
const guard = collisionGuard(robot); let prev = START.slice(), halted = false, everCollided = false;
for (let k = 0; k < 30; k++) { const next = prev.map((p, i) => p + (([0.5, 0.5][i]) - p) * 0.3); const g = guard.step(prev, next); if (collides(robot, g.command).hit) everCollided = true; if (g.halted) halted = true; prev = g.command; }
check('the protective stop guards the imported robot (halts, never commands a collision)', halted && !everCollided);

console.log(h(fails === 0
  ? '✅ URDF verified — real robot descriptions import into the collision + planning layers (primitives; mesh flagged)'
  : `❌ ${fails} URDF check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
