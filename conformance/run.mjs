// conformance runner — execute the normative battery (conformance/spec.mjs) against a PLUGGABLE
// implementation and return a structured report. The reference implementation passes this repo's
// skillcore + skillkit; a third-party runtime passes its own {bind} and {validateSkill, matchRobot}.
//
//   import { conformanceReport } from './conformance/run.mjs';
//   const report = await conformanceReport({ skill, robot, core, runtime, levels: ['skill','runtime'] });
//   report.conformant  // boolean
//
// `runtime` may be omitted to run skill-level requirements only.

import { REQUIREMENTS } from './spec.mjs';

export async function conformanceReport({ skill, robot, core, runtime, levels } = {}) {
  const want = levels || (runtime ? ['skill', 'runtime'] : ['skill']);
  const results = [];
  for (const req of REQUIREMENTS) {
    if (!want.includes(req.level)) continue;
    const ctx = { skill, robot, core, runtime };
    if (req.applies && !req.applies(ctx)) { results.push({ id: req.id, level: req.level, area: req.area, must: req.must, spec: req.spec, status: 'n/a', detail: 'not applicable to this skill' }); continue; }
    try {
      const { pass, detail } = await req.run(ctx);
      results.push({ id: req.id, level: req.level, area: req.area, must: req.must, spec: req.spec, status: pass ? 'pass' : 'fail', detail: detail || '' });
    } catch (e) {
      results.push({ id: req.id, level: req.level, area: req.area, must: req.must, spec: req.spec, status: 'fail', detail: `threw: ${e.message}` });
    }
  }
  const counts = { pass: 0, fail: 0, 'n/a': 0 };
  for (const r of results) counts[r.status]++;
  return { skill: skill?.manifest?.name, robot: robot?.name, levels: want, results, counts, conformant: counts.fail === 0 };
}
