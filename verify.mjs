// verify.mjs — the skillpack, end-to-end, with NO hardware.
// Proves the open skill contract works: capability gating → bind → policy → runtime safety envelope →
// real Feetech codec → valid wire packets → reproducible eval → the adversarial safety proof.
//
//   node v2/skillpack/verify.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, matchRobot, resolveDriver, bind, safetyClamp, runEval } from './skillkit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const robot = async (f) => JSON.parse(await readFile(resolve(HERE, 'robots', f), 'utf8'));
let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) fails++;
};
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

// Validate a Feetech STS/SMS SYNC-WRITE packet (Protocol 0): header FF FF FE, 0x83 instr, checksum.
function feetechValid(u8) {
  if (!(u8[0] === 0xFF && u8[1] === 0xFF && u8[2] === 0xFE)) return false;
  if (u8[4] !== 0x83) return false;                      // SYNC WRITE
  let sum = 0; for (let i = 2; i < u8.length - 1; i++) sum += u8[i];
  return u8[u8.length - 1] === ((~sum) & 0xFF);
}

const skill = await loadSkill(resolve(HERE, 'skills/arm-reach'));
console.log(h(`skillpack · ${skill.manifest.name}@${skill.manifest.version} — "${skill.manifest.title}"`));

// ── 1. capability negotiation ─────────────────────────────────────────────────
console.log(h('1 · Capability negotiation — will this run on MY robot? (answered before motion)'));
const so101 = await robot('so101.json');
const wx250 = await robot('wx250-dynamixel.json');
const maestro = await robot('maestro-arm.json');
const turtle = await robot('turtlebot.json');
const mSo = matchRobot(skill.manifest, so101);
const mWx = matchRobot(skill.manifest, wx250);
const mMa = matchRobot(skill.manifest, maestro);
const mTb = matchRobot(skill.manifest, turtle);
check('SO-101 (Feetech, 5-DoF arm) accepts arm-reach', mSo.ok);
check('WidowX-250 (Dynamixel, 6-DoF arm) accepts arm-reach', mWx.ok);
check('Maestro 4-DoF arm accepts arm-reach (min_dof=4)', mMa.ok);
check('TurtleBot (mobile base) is REJECTED with reasons', !mTb.ok, mTb.reasons.join(' · '));

// ── 2. transport resolution against the real driver registry ──
console.log(h('2 · Transport — resolved from the existing Forge driver registry (hwbridge)'));
const dSo = await resolveDriver(so101);
const dWx = await resolveDriver(wx250);
check('SO-101 → Feetech STS/SMS codec', dSo.codec && dSo.target.codec === 'feetech-scs', dSo.target.label);
check('WidowX-250 → Dynamixel 2.0 codec', dWx.codec && dWx.target.codec === 'dynamixel2', dWx.target.label);

// ── 3. bind + one real control tick → wire bytes ──
console.log(h('3 · Bind SO-101 · one tick · policy → safety envelope → real Feetech packet'));
const rt = await bind(skill, so101, { q0: [0.5, 0.5, 0.5, 0.5, 0.5] });
const tick = rt.step({ q: rt.state(), q_target: [0.9, 0.1, 0.9, 0.1, 0.9] });
check('policy PROPOSED the raw target (0.9…)', Math.abs(tick.proposed[0] - 0.9) < 1e-9);
check('runtime RAMPED it under max_step_norm', Math.abs(tick.q[0] - 0.5) <= skill.manifest.safety.max_step_norm + 1e-9,
      `Δ=${(tick.q[0] - 0.5).toFixed(3)} ≤ cap ${skill.manifest.safety.max_step_norm}`);
check('emitted a VALID Feetech wire packet', feetechValid(tick.wire.data),
      tick.wire.text.slice(0, 32) + '…');

// ── 4. reproducible eval ──
console.log(h('4 · Eval — reproducible reach episodes through the bound runtime'));
const ev = await runEval(skill, so101);
check(`reach success rate ≥ threshold (${skill.manifest.eval.threshold})`, ev.rate >= skill.manifest.eval.threshold,
      `${ev.passed}/${ev.total} = ${(ev.rate * 100).toFixed(0)}%`);
check('no per-tick step ever exceeded the velocity cap', ev.maxStepSeen <= skill.manifest.safety.max_step_norm + 1e-9,
      `max step seen = ${ev.maxStepSeen.toFixed(3)}`);
check('every command stayed within [0,1]', ev.allInRange);

// ── 5. the adversarial safety proof — a HIJACKED policy cannot break the envelope ──
console.log(h('5 · Safety envelope vs a hijacked/broken policy (the AgentRob case)'));
const evil = [NaN, 999, -50, Infinity, 0.5];   // garbage a compromised policy might emit
let prev = [0.5, 0.5, 0.5, 0.5, 0.5];
const safe = safetyClamp(prev, evil, { maxStep: skill.manifest.safety.max_step_norm, lo: 0, hi: 1 });
check('all outputs finite (NaN/Inf rejected → hold last)', safe.every(Number.isFinite), `[${safe.map(v=>v.toFixed(2)).join(', ')}]`);
check('all outputs within [0,1] (999 / -50 clamped)', safe.every((v) => v >= 0 && v <= 1));
check('no channel exceeded the per-tick cap', safe.every((v, i) => Math.abs(v - prev[i]) <= skill.manifest.safety.max_step_norm + 1e-9));

// also run the whole eval loop driven by the evil policy → wire must STILL be valid & bounded
const evilSkill = { ...skill, policyMod: { create: () => ({ step: () => [NaN, 9, -9, Infinity, 2] }) } };
const rtE = await bind(evilSkill, so101, { q0: [0.5,0.5,0.5,0.5,0.5] });
let evilBad = false;
for (let k = 0; k < 30; k++) { const t = rtE.step({}); if (!feetechValid(t.wire.data) || t.q.some(v=>v<0||v>1||!Number.isFinite(v))) evilBad = true; }
check('30 ticks of a hijacked policy → every wire packet still valid & bounded', !evilBad);

// ── summary ──
console.log(h(fails === 0
  ? '✅ skillpack verified end-to-end — open contract · capability-gated · transport-bound · safety-enveloped'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
