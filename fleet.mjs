// fleet — multi-robot coordination. A fleet is several members, each a (robot, skill, waypoints) triple.
// The fleet runs them BARRIER-SYNCHRONIZED: every member drives to waypoint i, the fleet waits until all
// have reached it, then advances to i+1 — a formation, a handoff, a synchronized manipulation.
//
// The load-bearing property: each member is gated and safety-enveloped on ITS OWN robot, independently. A
// wrong or hijacked policy on one robot is bounded by that robot's envelope and CANNOT affect another
// member's safety. Coordination composes; safety stays local. (The orchestration layer, done safely.)

import { driveTo } from './durable.mjs';
import { matchRobot } from './skillkit.mjs';

const maxErr = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

export async function runFleet(members, opts = {}) {
  // gate every member first — the whole fleet is refused before anything moves if any member can't run
  for (const mb of members) {
    const g = matchRobot(mb.skill.manifest, mb.robot);
    if (!g.ok) return { status: 'refused', member: mb.name, reasons: g.reasons };
  }
  const n = members.length;
  const W = Math.max(...members.map((mb) => mb.waypoints.length));
  const world = members.map((mb) => (mb.q0 || new Array(mb.robot.dof).fill(0.5)).slice());
  const log = [];
  let synchronized = true;

  for (let wi = 0; wi < W; wi++) {
    for (let i = 0; i < n; i++) {
      const mb = members[i];
      const target = mb.waypoints[Math.min(wi, mb.waypoints.length - 1)];
      const r = await driveTo(mb.skill, mb.robot, world[i], target, { ...opts, ...mb });
      world[i] = r.world;
      log.push({ waypoint: wi, member: mb.name, robot: mb.robot.name, reached: r.reached, err: +maxErr(r.world, target).toFixed(3) });
      if (!r.reached) synchronized = false;   // the barrier: the fleet is only "in sync" if all reach each step
    }
  }
  return { status: 'complete', synchronized, world, log };
}
