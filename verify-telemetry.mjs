// verify-telemetry.mjs — every safety intervention is recorded and auditable, and the trace is
// serializable + replayable. This is what lets an open, safety-enveloped registry be accountable: you can
// prove after the fact exactly what the runtime did with any policy.
//   node v2/skillpack/verify-telemetry.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, bind, resolveDriver } from './skillkit.mjs';
import { traced, replayWire } from './telemetry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const robot = JSON.parse(await readFile(join(HERE, 'robots/so101.json'), 'utf8'));
const reach = await loadSkill(join(HERE, 'skills/arm-reach'));

console.log(h('1 · A clean run traces mostly pass-through with few interventions'));
const rt = traced(await bind(reach, robot, { q0: [0.5, 0.5, 0.5, 0.5, 0.5] }), { skill: 'arm-reach', robot: robot.name });
for (let k = 0; k < 30; k++) rt.step({ q: rt.state(), q_target: [0.6, 0.45, 0.55, 0.5, 0.5] });
const clean = rt.trace();
check('trace has per-tick records', clean.ticks.length === 30 && clean.ticks[0].events.length === 5);
check('a summary with intervention counts', clean.summary && clean.summary.interventions && 'capped' in clean.summary.interventions,
      `caps ${clean.summary.interventions.capped} · holds ${clean.summary.interventions.held} · pass ${clean.summary.interventions.pass}`);
check('trace is JSON-serializable (an audit record)', typeof JSON.parse(JSON.stringify(clean)).summary.n_ticks === 'number');

console.log(h('2 · A hijacked policy — every intervention is captured'));
const evil = { ...reach, policyMod: { create: () => ({ step: () => [NaN, 9, -5, Infinity, 42] }) } };
const rtE = traced(await bind(evil, robot, { q0: [0.5, 0.5, 0.5, 0.5, 0.5] }), { skill: 'arm-reach', policy: 'hijacked' });
for (let k = 0; k < 20; k++) rtE.step({});
const evilTrace = rtE.trace();
check('the NaN channel is recorded as HELD', evilTrace.ticks[0].events[0] === 'held', `tick0 events ${JSON.stringify(evilTrace.ticks[0].events)}`);
// the velocity cap binds first (0.08/tick); once a channel saturates at [0,1] it becomes CLAMPED
check('early ticks are CAPPED (the accel/velocity limit binds first)', evilTrace.ticks[0].events.includes('capped'));
check('later ticks show CLAMPED once a channel saturates at the range', evilTrace.ticks.some((t) => t.events.includes('clamped')),
      `clamp first appears at tick ${evilTrace.ticks.findIndex((t) => t.events.includes('clamped'))}`);
check('the run was mostly intervention (rate > 0.9)', evilTrace.summary.intervention_rate > 0.9, `rate ${evilTrace.summary.intervention_rate}`);
check('the trace still shows within_cap true (envelope held)', evilTrace.summary.within_cap);

console.log(h('3 · The trace is replayable — the command stream re-derives the same wire'));
const { codec } = await resolveDriver(robot);
const ids = robot.joint_ids;
// re-run live, capturing the actual wire, then compare to a replay of the recorded commands
const rt2 = traced(await bind(reach, robot, { q0: [0.5, 0.5, 0.5, 0.5, 0.5] }));
const liveWire = [];
for (let k = 0; k < 15; k++) { const t = rt2.step({ q: rt2.state(), q_target: [0.7, 0.3, 0.6, 0.4, 0.55] }); liveWire.push(t.wire.text); }
const replay = replayWire(rt2.trace(), codec, ids);
check('replayed wire matches the live wire tick-for-tick', JSON.stringify(replay) === JSON.stringify(liveWire),
      `${replay.length} ticks reproduced`);

console.log(h(fails === 0
  ? '✅ telemetry verified — every intervention recorded, trace serializable + replayable (auditable safety)'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
