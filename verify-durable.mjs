// verify-durable.mjs — the durable runtime survives a fault mid-execution without redoing completed work,
// checkpoints serialize, human intervention suspend/resume works, and progress-aware rollback redoes only
// the steps a disturbance actually invalidated.
//   node v2/skillpack/verify-durable.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill } from './skillkit.mjs';
import { runDurable, resume } from './durable.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const robot = JSON.parse(await readFile(join(HERE, 'robots/so101.json'), 'utf8'));
const skill = await loadSkill(join(HERE, 'skills/arm-reach'));

// a 3-waypoint task: pick region → transit → place region (each a joint sub-goal)
const q0 = [0.5, 0.5, 0.5, 0.5, 0.5];
const waypoints = [
  { target: [0.8, 0.3, 0.6, 0.4, 0.6] },   // 0 · approach
  { target: [0.2, 0.7, 0.4, 0.6, 0.5] },   // 1 · transit
  { target: [0.6, 0.4, 0.7, 0.35, 0.9] },  // 2 · place (gripper closed)
];

console.log(h('1 · A full durable run completes every waypoint'));
const full = await runDurable(skill, robot, waypoints, { q0 });
check('status complete', full.status === 'complete', `${full.done?.length}/3 waypoints · ${full.totalTicks} ticks`);
const fullTicks = full.totalTicks;

console.log(h('2 · A fault after waypoint 2 yields a serializable checkpoint'));
const faulted = await runDurable(skill, robot, waypoints, { q0, faultAfter: 1 });
check('run reports faulted with a checkpoint', faulted.status === 'faulted' && faulted.checkpoint);
const ckpt = JSON.parse(JSON.stringify(faulted.checkpoint));   // prove it round-trips through JSON (durable state)
check('checkpoint is JSON-serializable and shows 2 waypoints done', ckpt.done.length === 2 && Array.isArray(ckpt.world),
      `done ${JSON.stringify(ckpt.done)} · nextWaypoint ${ckpt.nextWaypoint}`);

console.log(h('3 · Resume finishes WITHOUT redoing completed work (the point of durability)'));
const resumed = await resume(skill, robot, waypoints, ckpt, {});
check('resume completes the task', resumed.status === 'complete' && resumed.done.length === 3);
check('resume executed ONLY the remaining waypoint (not 0 or 1)', JSON.stringify(resumed.executedOnResume) === JSON.stringify([2]),
      `ran ${JSON.stringify(resumed.executedOnResume)} on resume`);
check('resume did far less work than a full run (durable, not restarted)', resumed.workTicks < fullTicks * 0.6,
      `resume ${resumed.workTicks} ticks vs full ${fullTicks}`);
check('no rollback needed when the checkpoint is still valid', resumed.rolledBack === 0);

console.log(h('4 · Human-in-the-loop: suspend mid-task, resume later'));
let saved = null;
const paused = await runDurable(skill, robot, waypoints, { q0, faultAfter: 0, onCheckpoint: (c) => { saved = c; } });
check('suspended after waypoint 1 (operator paused)', paused.status === 'faulted' && saved.done.length === 1);
const afterResume = await resume(skill, robot, waypoints, saved, {});
check('resumes to completion after the pause', afterResume.status === 'complete' && afterResume.done.length === 3,
      `executed ${JSON.stringify(afterResume.executedOnResume)} after resume`);

console.log(h('5 · Progress-aware rollback — a regressed checkpoint redoes only what broke'));
// take the valid 2-done checkpoint, but corrupt the world so waypoint 1 no longer holds (a shove during downtime)
const regressed = JSON.parse(JSON.stringify(ckpt));
regressed.world = [0.75, 0.32, 0.6, 0.42, 0.6];   // near waypoint 0, NOT waypoint 1 → waypoint 1 invalidated
const rolled = await resume(skill, robot, waypoints, regressed, {});
check('detected the regression and rolled back waypoint 1', rolled.rolledBack >= 1, `rolledBack ${rolled.rolledBack}`);
check('redid waypoint 1 then finished (2 executed, not 1)', rolled.status === 'complete' && rolled.executedOnResume.includes(1) && rolled.executedOnResume.includes(2));
check('a valid checkpoint would NOT have rolled back', resumed.rolledBack === 0 && rolled.rolledBack > resumed.rolledBack);

console.log(h(fails === 0
  ? '✅ durable runtime verified — checkpoint · resume-without-redo · HITL suspend · progress-aware rollback'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
