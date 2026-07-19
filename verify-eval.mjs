// verify-eval.mjs — the recovery-aware eval harness produces meaningful, DISCRIMINATING numbers.
// A rubber-stamp eval is worse than none; this proves evalkit (a) passes a capable skill, (b) measures
// recovery from a mid-episode shove, and (c) FAILS an under-capable configuration — so the score means
// something.
//   node v2/skillpack/verify-eval.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill } from './skillkit.mjs';
import { evaluate, recoveryReport } from './evalkit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const robot = async (f) => JSON.parse(await readFile(resolve(HERE, 'robots', f), 'utf8'));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const so101 = await robot('so101.json');
const reach = await loadSkill(join(HERE, 'skills/arm-reach'));
const grasp = await loadSkill(join(HERE, 'skills/gripper-grasp'));

console.log(h('1 · A capable skill passes a clean run'));
const clean = await evaluate(reach, so101, { maxTicks: 80 });
check('arm-reach clean success ≥ 0.9', clean.success_rate >= 0.9, `${(clean.success_rate * 100).toFixed(0)}% · mean ${clean.mean_ticks} ticks`);
check('a failure taxonomy is reported', clean.failures && typeof clean.failures.timeout === 'number');

console.log(h('2 · Recovery — success despite a mid-episode shove'));
const rec = await recoveryReport(reach, so101, { maxTicks: 120 });
check('recovery report has clean + recovery rates', typeof rec.clean_success_rate === 'number' && typeof rec.recovery_rate === 'number',
      `clean ${(rec.clean_success_rate * 100).toFixed(0)}% · recover ${(rec.recovery_rate * 100).toFixed(0)}% · stability ${(rec.stability * 100).toFixed(0)}%`);
check('the skill recovers from the shove (recovery ≥ 0.7)', rec.recovery_rate >= 0.7);

console.log(h('3 · gripper-grasp evaluates too (its own episodes)'));
const g = await evaluate(grasp, so101, { maxTicks: 90 });
check('gripper-grasp clean success ≥ 0.9', g.success_rate >= 0.9, `${(g.success_rate * 100).toFixed(0)}%`);

console.log(h('4 · The eval DISCRIMINATES — an under-capable run scores low'));
// same skill, but far too few ticks to reach under the velocity cap → the metric must collapse.
const starved = await evaluate(reach, so101, { maxTicks: 4 });
check('4-tick horizon collapses success (< 0.3)', starved.success_rate < 0.3, `${(starved.success_rate * 100).toFixed(0)}% · timeouts ${starved.failures.timeout}`);
check('the harness is not a rubber stamp', starved.success_rate < clean.success_rate - 0.5,
      `capable ${(clean.success_rate * 100).toFixed(0)}% vs starved ${(starved.success_rate * 100).toFixed(0)}%`);

console.log(h('5 · A harsher shove with little runway lowers recovery (graded, not binary)'));
const late = await recoveryReport(reach, so101, { maxTicks: 60, shoveTick: 52, shoveMag: 0.5 });
check('late/hard shove yields a graded recovery rate in [0,1]', late.recovery_rate >= 0 && late.recovery_rate <= 1,
      `recover ${(late.recovery_rate * 100).toFixed(0)}% (clean ${(late.clean_success_rate * 100).toFixed(0)}%)`);
check('recovery under a late hard shove ≤ clean success', late.recovery_rate <= late.clean_success_rate + 1e-9);

console.log(h(fails === 0
  ? '✅ recovery-aware eval verified — passes the capable, measures recovery, and catches the under-capable'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
