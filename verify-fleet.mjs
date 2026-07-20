// verify-fleet.mjs — multi-robot coordination with per-robot safety isolation. Two HETEROGENEOUS arms
// (SO-101 on Feetech, WidowX-250 on Dynamixel) run a coordinated handoff, each gated and safety-enveloped
// on its own robot. The point: coordination composes, but a hijacked policy on one robot is bounded by
// that robot's envelope and cannot affect the other member.
//   node v2/skillpack/verify-fleet.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, matchRobot, bind, resolveDriver } from './skillkit.mjs';
import { safetyClamp } from './skillcore.mjs';
import { runFleet } from './fleet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const robot = async (f) => JSON.parse(await readFile(resolve(HERE, 'robots', f), 'utf8'));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const reach = await loadSkill(join(HERE, 'skills/arm-reach'));
const so101 = await robot('so101.json');          // 5-DoF, Feetech
const wx250 = await robot('wx250-dynamixel.json'); // 6-DoF, Dynamixel

// a two-arm handoff: approach → handoff/receive (the synchronized moment) → retract/hold
const memberA = { name: 'giver', robot: so101, skill: reach, q0: [0.5, 0.5, 0.5, 0.5, 0.5],
  waypoints: [[0.7, 0.35, 0.6, 0.4, 0.2], [0.55, 0.5, 0.55, 0.5, 0.9], [0.4, 0.6, 0.5, 0.55, 0.2]] };
const memberB = { name: 'taker', robot: wx250, skill: reach, q0: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  waypoints: [[0.3, 0.6, 0.4, 0.6, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5, 0.5, 0.95], [0.5, 0.5, 0.5, 0.5, 0.5, 0.95]] };

console.log(h('1 · A heterogeneous fleet gates + coordinates a handoff'));
const run = await runFleet([memberA, memberB], { maxTicks: 80 });
check('the fleet completes', run.status === 'complete');
check('both members reached every synchronized waypoint (barrier held)', run.synchronized,
      run.log.filter((l) => !l.reached).map((l) => `${l.member}@wp${l.waypoint}`).join(', ') || 'all reached');
check('it drove BOTH arms — SO-101 and WidowX', run.log.some((l) => l.robot.includes('SO-101')) && run.log.some((l) => l.robot.includes('WidowX')));

console.log(h('2 · Each robot streamed its OWN transport'));
const dA = await resolveDriver(so101), dB = await resolveDriver(wx250);
check('giver → Feetech, taker → Dynamixel (heterogeneous, one fleet)', dA.target.codec === 'feetech-scs' && dB.target.codec === 'dynamixel2');

console.log(h('3 · Per-robot safety isolation — a hijacked member is bounded, the other is unaffected'));
// member A hijacked (garbage policy); member B normal. Both run in the fleet.
const evilReach = { ...reach, policyMod: { create: () => ({ step: () => [NaN, 9, -5, Infinity, 42] }) } };
const hijackedA = { ...memberA, skill: evilReach };
const run2 = await runFleet([hijackedA, memberB], { maxTicks: 60 });
// A can't reach (garbage) so the fleet isn't "synchronized", but that's isolated to A:
check('the taker (normal) still reached its waypoints', run2.log.filter((l) => l.member === 'taker').every((l) => l.reached));
check('the fleet reports out-of-sync because only the giver failed (isolated)', !run2.synchronized && run2.log.some((l) => l.member === 'giver' && !l.reached));
// and A's commands were still bounded by its own envelope (drive it directly to confirm)
const rtE = await bind(evilReach, so101, { q0: [0.5, 0.5, 0.5, 0.5, 0.5] });
const { codec } = await resolveDriver(so101);
let bad = false;
for (let k = 0; k < 40; k++) { const t = rtE.step({}); if (!(t.wire && t.wire.data && t.wire.data.length) || t.q.some((v) => v < 0 || v > 1 || !Number.isFinite(v))) bad = true; }
check('the hijacked giver stayed inside its own safety envelope', !bad);

console.log(h('4 · The fleet is refused if any member cannot run'));
const badMember = { name: 'legs', robot: await robot('quadruped.json'), skill: reach, waypoints: [[0.5, 0.5, 0.5, 0.5, 0.5]] };
const refused = await runFleet([memberA, badMember], {});
check('an arm skill on a quadruped member refuses the whole fleet', refused.status === 'refused' && refused.member === 'legs', (refused.reasons || [])[0]);

console.log(h(fails === 0
  ? '✅ fleet verified — heterogeneous multi-robot coordination, per-robot safety isolation'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
