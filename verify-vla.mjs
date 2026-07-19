// verify-vla.mjs — the POLICY SWAP, proven. arm-reach (analytic) → arm-reach-vla (real SmolVLA),
// same contract · safety envelope · transport · eval harness. No hardware, no GPU here: the 450M
// SmolVLA weights run in-browser on WebGPU; this harness validates the contract + safety wrapping
// with a stand-in for the forward pass.
//
//   node v2/skillpack/verify-vla.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, matchRobot, bind, safetyClamp } from './skillkit.mjs';
import { SMOLVLA_CFG } from './policies/smolvla.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const robot = async (f) => JSON.parse(await readFile(resolve(HERE, 'robots', f), 'utf8'));
const rawManifest = async (name) => JSON.parse(await readFile(resolve(HERE, 'skills', name, 'skill.json'), 'utf8'));
let fails = 0;
const check = (name, cond, detail = '') => { console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;
function feetechValid(u8) {
  if (!(u8[0] === 0xFF && u8[1] === 0xFF && u8[2] === 0xFE) || u8[4] !== 0x83) return false;
  let sum = 0; for (let i = 2; i < u8.length - 1; i++) sum += u8[i];
  return u8[u8.length - 1] === ((~sum) & 0xFF);
}

// A stand-in for SmolVLA's forward pass (WebGPU absent in Node). Returns a real-shaped action chunk
// [chunkSize × maxActionDim]. `mode:'reach'` = plausible normalized actions; `mode:'ood'` = the kind
// of out-of-range / spiky output a real VLA can emit under distribution shift or attack.
function standInBackend(mode = 'reach', targets = [0.8, 0.3, 0.65, 0.45, 0.55]) {
  let calls = 0;
  return {
    get calls() { return calls; },
    infer() {
      calls++;
      const { chunkSize, maxActionDim } = SMOLVLA_CFG;
      const out = new Float32Array(chunkSize * maxActionDim);
      for (let s = 0; s < chunkSize; s++) {
        for (let d = 0; d < maxActionDim; d++) {
          const idx = s * maxActionDim + d;
          if (mode === 'ood') out[idx] = [NaN, 7.5, -3.0, Infinity, 42][d % 5];   // garbage
          else out[idx] = d < targets.length ? targets[d] : 0;                    // plausible
        }
      }
      return out;
    },
  };
}

const analytic = await rawManifest('arm-reach');
const vla = await rawManifest('arm-reach-vla');
console.log(h(`policy swap · ${analytic.name} → ${vla.name}  (analytic P-controller → real SmolVLA 450M)`));

// ── 1. manifest diff — what actually changed in the swap ──
console.log(h('1 · Manifest diff — swap changes the policy (and its sensor needs), nothing else'));
const KEYS = ['task', 'safety', 'io', 'contract', 'requires', 'eval'];
const same = (k) => JSON.stringify(analytic[k]) === JSON.stringify(vla[k]);
check('policy block CHANGED (analytic → vla)', analytic.policy.kind === 'analytic' && vla.policy.kind === 'vla',
      `kind: "${analytic.policy.kind}" → "${vla.policy.kind}"`);
check('safety envelope IDENTICAL', same('safety'), JSON.stringify(vla.safety));
check('contract GUARANTEES identical (post-conditions + invariants)',
      JSON.stringify(analytic.contract.post) === JSON.stringify(vla.contract.post) &&
      JSON.stringify(analytic.contract.invariants) === JSON.stringify(vla.contract.invariants));
check('contract PRE-conditions differ (VLA needs camera+task, not q_target) — honest, inputs changed',
      JSON.stringify(analytic.contract.pre) !== JSON.stringify(vla.contract.pre));
check('io / action space IDENTICAL', same('io'));
check('eval metric + threshold IDENTICAL', analytic.eval.metric === vla.eval.metric && analytic.eval.threshold === vla.eval.threshold);
const sensorsDiff = JSON.stringify(analytic.requires.sensors) !== JSON.stringify(vla.requires.sensors);
check('requires.sensors changed (VLA needs a camera, not an IK target_pose)', sensorsDiff,
      `${JSON.stringify(analytic.requires.sensors)} → ${JSON.stringify(vla.requires.sensors)}`);
check('morphology / min_dof / actuation IDENTICAL',
      analytic.requires.morphology === vla.requires.morphology && analytic.requires.min_dof === vla.requires.min_dof && analytic.requires.actuation === vla.requires.actuation);

// ── 2. capability gating — the camera requirement changes who can run it ──
console.log(h('2 · Capability negotiation — the VLA needs vision, so gating differs from the baseline'));
const vlaSkill = await loadSkill(resolve(HERE, 'skills/arm-reach-vla'));
const so101 = await robot('so101.json'), wx250 = await robot('wx250-dynamixel.json');
const maestro = await robot('maestro-arm.json'), turtle = await robot('turtlebot.json');
check('SO-101 (has camera) accepts the VLA skill', matchRobot(vla, so101).ok);
check('WidowX-250 (has camera) accepts the VLA skill', matchRobot(vla, wx250).ok);
const mMa = matchRobot(vla, maestro);
check('Maestro arm REJECTED — ran the analytic skill, but the VLA needs a camera', !mMa.ok, mMa.reasons.join(' · '));
check('TurtleBot still rejected', !matchRobot(vla, turtle).ok);

// ── 3. same runtime path: SmolVLA action chunk → safety envelope → real Feetech packet ──
console.log(h('3 · Bind SO-101 · SmolVLA action chunk → the SAME safety envelope → real Feetech packet'));
const be = standInBackend('reach');
const rt = await bind(vlaSkill, so101, { q0: [0.5, 0.5, 0.5, 0.5, 0.5], policyOpts: { backend: be } });
const tick = rt.step({ image: null, task: 'reach the target', state: [0.5, 0.5, 0.5, 0.5, 0.5] });
check('VLA proposed an action (from the chunk)', Array.isArray(tick.proposed) && tick.proposed.length === 5);
check('runtime ramped it under max_step_norm', Math.abs(tick.q[0] - 0.5) <= vla.safety.max_step_norm + 1e-9,
      `Δ=${(tick.q[0] - 0.5).toFixed(3)} ≤ cap ${vla.safety.max_step_norm}`);
check('emitted a VALID Feetech wire packet — same transport as the baseline', feetechValid(tick.wire.data),
      tick.wire.text.slice(0, 28) + '…');

// ── 4. action chunking — re-infer only when the 50-step chunk is spent ──
console.log(h('4 · Action chunking — SmolVLA emits 50 steps/call; re-infer only when spent'));
be.infer && (() => {})();
const be2 = standInBackend('reach');
const rt2 = await bind(vlaSkill, so101, { q0: [0.5,0.5,0.5,0.5,0.5], policyOpts: { backend: be2 } });
for (let k = 0; k < 50; k++) rt2.step({ task: 'reach', state: [0.5,0.5,0.5,0.5,0.5] });
const after50 = be2.calls;
rt2.step({ task: 'reach', state: [0.5,0.5,0.5,0.5,0.5] });
check('1 inference covers 50 control ticks', after50 === 1, `${after50} call over 50 ticks`);
check('tick 51 triggers the next inference', be2.calls === 2);

// ── 5. THE POINT: the safety property transfers to a real learned policy ──
console.log(h('5 · Safety envelope vs an out-of-distribution / hijacked VLA (the property transfers)'));
const ood = safetyClamp([0.5,0.5,0.5,0.5,0.5], [NaN, 7.5, -3.0, Infinity, 42].slice(0,5),
                        { maxStep: vla.safety.max_step_norm, lo: 0, hi: 1 });
check('OOD VLA output made finite + in [0,1]', ood.every((v) => Number.isFinite(v) && v >= 0 && v <= 1), `[${ood.map(v=>v.toFixed(2)).join(', ')}]`);
const beO = standInBackend('ood');
const rtO = await bind(vlaSkill, so101, { q0: [0.5,0.5,0.5,0.5,0.5], policyOpts: { backend: beO } });
let bad = false;
for (let k = 0; k < 60; k++) { const t = rtO.step({ task: 'x', state: [0,0,0,0,0] }); if (!feetechValid(t.wire.data) || t.q.some(v => v < 0 || v > 1 || !Number.isFinite(v))) bad = true; }
check('60 ticks of a garbage-emitting VLA → every wire packet still valid & bounded', !bad);

console.log(h('note') + ' The 450M SmolVLA weights run in-browser on WebGPU (onnxruntime-web); this harness');
console.log(' validates the contract + safety wrapping with a stand-in forward pass. The adapter');
console.log(' (policy.smolvla.mjs) is the real in-browser integration — see webgpuBackend().');

console.log(h(fails === 0
  ? '✅ policy swap verified — same contract/safety/transport, analytic → real VLA, one policy block'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
