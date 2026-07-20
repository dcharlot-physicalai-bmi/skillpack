// verify-interop.mjs — is the conformance suite REAL, or does it only describe our own runtime? Two proofs:
//   (A) a SECOND, clean-room runtime (interop/miniruntime.mjs — shares no code with skillkit) PASSES the
//       runtime battery across position/velocity/torque → the standard is independently implementable.
//   (B) a set of runtimes each broken in ONE way get CAUGHT by the RIGHT requirement → the suite has teeth.
// A conformance suite that nothing can fail is theater; this is how a standard validates its own tests.
//   node v2/skillpack/verify-interop.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchRobot } from './skillcore.mjs';
import { loadSkill } from './skillkit.mjs';
import { conformanceReport } from './conformance/run.mjs';
import { bind as miniBind } from './interop/miniruntime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const reg = JSON.parse(await readFile(join(HERE, 'registry.json'), 'utf8'));
const robots = [];
for (const r of reg.robots) robots.push(JSON.parse(await readFile(resolve(HERE, r.path), 'utf8')));
const load = async (name) => {
  const s = reg.skills.find((x) => x.name === name);
  const skill = await loadSkill(resolve(HERE, s.path));
  const robot = robots.find((rb) => matchRobot(skill.manifest, rb).ok);
  return { skill, robot };
};
const runtimeReport = (fix, runtime) => conformanceReport({ ...fix, core: {}, runtime, levels: ['runtime'] });

// ── (A) an independent runtime passes ────────────────────────────────────────────────────────────
console.log(h('A · a clean-room second runtime passes the runtime battery (position · velocity · torque)'));
for (const [name, label] of [['arm-reach', 'position'], ['mobile-goto', 'velocity'], ['arm-compliant-push', 'torque']]) {
  const fix = await load(name);
  const report = await runtimeReport(fix, { bind: miniBind });
  const failed = report.results.filter((r) => r.status === 'fail').map((r) => r.id);
  check(`miniruntime is CONFORMANT on ${name} (${label})`, report.conformant, `${report.counts.pass} pass · ${report.counts['n/a']} n/a${failed.length ? ' · FAILS ' + failed.join(', ') : ''}`);
}

// ── (B) broken runtimes get caught ───────────────────────────────────────────────────────────────
// Each of these mirrors miniruntime but sabotages exactly one guarantee. The battery must catch it.
function makeBroken(flaw) {
  return (skill, robot) => {
    const m = skill.manifest, dof = robot.dof, a = m.requires.actuation;
    const sym = a === 'velocity' || a === 'torque';
    const lo = a === 'velocity' ? -m.safety.max_speed_norm : a === 'torque' ? -m.safety.max_torque_norm : (m.safety.clamp || [0, 1])[0];
    const hi = a === 'velocity' ? m.safety.max_speed_norm : a === 'torque' ? m.safety.max_torque_norm : (m.safety.clamp || [0, 1])[1];
    const maxStep = a === 'velocity' ? m.safety.max_accel_norm : a === 'torque' ? m.safety.max_torque_rate_norm : m.safety.max_step_norm;
    const home = () => new Array(dof).fill(flaw === 'symmetric-nonzero' ? 0.5 : (sym ? 0 : 0.5));
    const policy = skill.policyMod.create(m, robot);
    let prev = home();
    const clamp = (p, v) => { let x = Number.isFinite(v) ? v : p; const d = x - p; if (d > maxStep) x = p + maxStep; else if (d < -maxStep) x = p - maxStep; return Math.max(lo, Math.min(hi, x)); };
    const rangeOnly = (p, v) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : p));
    return {
      envelope: { lo, hi, maxStep }, symmetric: sym,
      state: () => prev.slice(),
      reset() { prev = flaw === 'bad-reset' ? new Array(dof).fill(9) : home(); },
      estop() { return flaw === 'bad-estop' ? new Array(dof).fill(99) : (sym ? new Array(dof).fill(0) : prev.slice()); },
      step(obs) {
        const proposed = policy.step(obs) || [];
        let safe;
        if (flaw === 'no-clamp') safe = Array.from({ length: dof }, (_, i) => proposed[i]);                          // no bounding at all
        else if (flaw === 'no-rate-cap') safe = prev.map((p, i) => rangeOnly(p, proposed[i]));                       // range ok, rate uncapped
        else if (flaw === 'nan-leak') safe = prev.map((p, i) => Number.isFinite(proposed[i]) ? clamp(p, proposed[i]) : proposed[i]); // leaks NaN/Inf
        else safe = prev.map((p, i) => clamp(p, proposed[i]));                                                       // (correct)
        prev = safe;
        return { q: safe.slice(), wire: { data: safe.map(() => 1) } };
      },
    };
  };
}

console.log(h('B · deliberately-broken runtimes are caught by the right requirement'));
const CASES = [
  { flaw: 'no-clamp', skill: 'arm-reach', expect: 'RT-ENVELOPE-CLAMP', why: 'emits the raw policy proposal, unbounded' },
  { flaw: 'no-rate-cap', skill: 'arm-reach', expect: 'RT-STEP-CAP', why: 'clamps range but not per-tick rate' },
  { flaw: 'nan-leak', skill: 'arm-reach', expect: 'RT-NAN-REJECT', why: 'lets NaN/Inf reach the wire' },
  { flaw: 'bad-estop', skill: 'arm-reach', expect: 'RT-ESTOP', why: 'estop returns an out-of-range command' },
  { flaw: 'bad-reset', skill: 'arm-reach', expect: 'RT-RESET-HOME', why: 'reset lands out of range' },
  { flaw: 'symmetric-nonzero', skill: 'mobile-goto', expect: 'RT-SYMMETRIC-ZERO', why: 'symmetric runtime starts nonzero' },
];
for (const cs of CASES) {
  const fix = await load(cs.skill);
  const report = await runtimeReport(fix, { bind: makeBroken(cs.flaw) });
  const failed = report.results.filter((r) => r.status === 'fail').map((r) => r.id);
  const caught = !report.conformant && failed.includes(cs.expect);
  check(`"${cs.flaw}" (${cs.why}) → caught by ${cs.expect}`, caught, `NOT conformant=${!report.conformant}, failed: ${failed.join(', ') || '(none!)'}`);
}

console.log(h(fails === 0
  ? '✅ interop verified — an independent runtime passes, and every sabotage is caught. The conformance suite is real.'
  : `❌ ${fails} interop check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
