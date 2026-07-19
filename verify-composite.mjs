// verify-composite.mjs — skills compose. A composite runs its sub-skills in order, each capability-gated
// and safety-enveloped, and it is durable: a fault mid-composite resumes without redoing completed steps.
//   node v2/skillpack/verify-composite.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadComposite, matchComposite, runComposite, resumeComposite } from './composite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const robot = async (f) => JSON.parse(await readFile(resolve(HERE, 'robots', f), 'utf8'));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const comp = await loadComposite(join(HERE, 'composites/pick-and-place'), HERE);
const so101 = await robot('so101.json');
const maestro = await robot('maestro-arm.json');   // 4-DoF: the grasp step needs 5
const turtle = await robot('turtlebot.json');

console.log(h('1 · A composite resolves its sub-skills from the registry'));
check('pick-and-place = reach → grasp → reach', comp.steps.map((s) => s.skill.manifest.name).join(' → ') === 'arm-reach → gripper-grasp → arm-reach',
      comp.steps.map((s) => s.skill.manifest.name).join(' → '));

console.log(h('2 · It gates on the whole chain (every step must run on the robot)'));
check('runs on SO-101 (5-DoF)', matchComposite(comp, so101).ok);
const onMa = matchComposite(comp, maestro);
check('refused on the 4-DoF Maestro — the grasp step needs 5', !onMa.ok, onMa.reasons.find((r) => /grasp/.test(r)) || onMa.reasons[0]);
check('refused on the TurtleBot (wrong morphology)', !matchComposite(comp, turtle).ok);

console.log(h('3 · It executes all steps, each through its own safety envelope'));
const run = await runComposite(comp, so101, { q0: [0.5, 0.5, 0.5, 0.5, 0.1] });
check('status complete, all 3 steps reached', run.status === 'complete' && run.log.every((s) => s.reached),
      run.log.map((s) => `${s.skill}:${s.ticks}t`).join(' · '));

console.log(h('4 · Durable — a fault after the grasp resumes without redoing reach+grasp'));
const faulted = await runComposite(comp, so101, { q0: [0.5, 0.5, 0.5, 0.5, 0.1], faultAfter: 1 });
check('faults after step 1 (grasp) with a checkpoint', faulted.status === 'faulted' && faulted.checkpoint.done.length === 2);
const ckpt = JSON.parse(JSON.stringify(faulted.checkpoint));   // serialize the durable state
const resumed = await resumeComposite(comp, so101, ckpt, {});
check('resume completes the composite', resumed.status === 'complete' && resumed.done.length === 3);
check('resume ran ONLY the carry step (not reach or grasp)', JSON.stringify(resumed.executedOnResume) === JSON.stringify([2]),
      `executed ${JSON.stringify(resumed.executedOnResume)} on resume`);
check('resume did far less work than the full run', resumed.workTicks < run.totalTicks * 0.6, `resume ${resumed.workTicks} vs full ${run.totalTicks}`);

console.log(h('5 · Progress-aware rollback across sub-skills'));
const regressed = JSON.parse(JSON.stringify(ckpt));
regressed.world = [0.5, 0.5, 0.5, 0.5, 0.5];   // world drifted: neither reach nor grasp goal holds now
const rolled = await resumeComposite(comp, so101, regressed, {});
check('detected the regression and redid the invalidated steps', rolled.rolledBack >= 1 && rolled.status === 'complete',
      `rolledBack ${rolled.rolledBack} · executed ${JSON.stringify(rolled.executedOnResume)}`);

console.log(h(fails === 0
  ? '✅ composite skills verified — gated per-step, safety-enveloped per-step, durable, progress-aware'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
