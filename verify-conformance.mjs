// verify-conformance.mjs — run the NORMATIVE conformance battery (conformance/spec.mjs) against the
// reference implementation (this repo's skillcore + skillkit), across EVERY skill in the registry, each
// on a capability-matched robot. This proves the reference implementation passes its own published
// standard — and is exactly the harness a third party runs against THEIR runtime to self-certify.
//   node v2/skillpack/verify-conformance.mjs
//   node v2/skillpack/verify-conformance.mjs --report   # print every requirement's result

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSkill, matchRobot } from './skillcore.mjs';
import { loadSkill, bind } from './skillkit.mjs';
import { conformanceReport } from './conformance/run.mjs';
import { REQUIREMENTS } from './conformance/spec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const showReport = process.argv.includes('--report');
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const core = { validateSkill, matchRobot };
const runtime = { bind };
const reg = JSON.parse(await readFile(join(HERE, 'registry.json'), 'utf8'));
const robots = [];
for (const r of reg.robots) robots.push(JSON.parse(await readFile(resolve(HERE, r.path), 'utf8')));

console.log(h(`conformance battery — ${REQUIREMENTS.length} requirements (${REQUIREMENTS.filter((r) => r.level === 'skill').length} skill · ${REQUIREMENTS.filter((r) => r.level === 'runtime').length} runtime) across ${reg.skills.length} skills`));

let totalReqs = 0, totalPass = 0, everCovered = new Set();
for (const s of reg.skills) {
  const skill = await loadSkill(resolve(HERE, s.path));
  const robot = robots.find((rb) => matchRobot(skill.manifest, rb).ok);
  if (!robot) { check(`${s.name}`, false, 'no compatible sample robot to certify against'); continue; }
  const report = await conformanceReport({ skill, robot, core, runtime });
  totalReqs += report.counts.pass + report.counts.fail;
  totalPass += report.counts.pass;
  report.results.forEach((r) => { if (r.status !== 'n/a') everCovered.add(r.id); });
  const failed = report.results.filter((r) => r.status === 'fail');
  check(`${s.name} on ${robot.name}`, report.conformant, `${report.counts.pass} pass · ${report.counts['n/a']} n/a${failed.length ? ' · FAILS: ' + failed.map((f) => f.id).join(', ') : ''}`);
  if (showReport || failed.length) {
    for (const r of report.results) console.log(`      ${r.status === 'pass' ? '·' : r.status === 'n/a' ? '○' : '✗'} ${r.id} [${r.spec}] ${r.detail}`);
  }
}

console.log(h('coverage'));
check('every requirement was exercised by at least one skill', everCovered.size === REQUIREMENTS.length,
  `${everCovered.size}/${REQUIREMENTS.length} requirements covered`);
check('all reference-implementation conformance checks passed', totalPass === totalReqs, `${totalPass}/${totalReqs} applicable checks`);

console.log(h(fails === 0
  ? '✅ conformance verified — the reference implementation passes the published skillpack standard on every skill'
  : `❌ ${fails} conformance failure(s)`));
process.exit(fails === 0 ? 0 : 1);
