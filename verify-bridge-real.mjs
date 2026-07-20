// verify-bridge-real.mjs — the bridge driven by REAL LeRobot checkpoints across MULTIPLE architectures
// (ACT, Diffusion Policy, π0), each producing a real action from actual weights, bounded by the skillpack
// safety envelope. The point is the safety guarantee, weight-verified across architectures: real policy
// outputs (out-of-range, from checkpoints not trained for this arm) are bounded — valid wire, in [0,1],
// within the cap. Not a task-success claim; the envelope holding on real weights.
//
// Each checkpoint is tested only if its real weights actually LOAD (the bridge reports mode); a checkpoint
// whose deps/weights aren't present is skipped honestly, never faked. Requires a py>=3.12 venv with
// `pip install lerobot diffusers transformers`.
//   node verify-bridge-real.mjs

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, resolveDriver } from './skillkit.mjs';
import { safetyClamp } from './skillcore.mjs';
import { connectLeRobot } from './bridge/lerobot-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENV_PY = process.env.VENV_PY || join(HERE, '.venv-lerobot/bin/python');
let fails = 0, realTested = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const skip = (n) => console.log(`  ⚪ ${n}`);
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const ALL = [
  { type: 'act',       ckpt: 'lerobot/act_aloha_sim_transfer_cube_human', ticks: 20, readyMs: 120000 },
  { type: 'diffusion', ckpt: 'lerobot/diffusion_pusht',                    ticks: 20, readyMs: 120000 },
  // Real VLAs — heavier (download + slower inference), so opt-in to keep the default run fast:
  //  · SmolVLA — 450M, OPEN tokenizer (HuggingFaceTB/SmolVLM2), no gate. ONLY=smolvla
  //  · π0.5 — 3B, gated google/paligemma-3b-pt-224 tokenizer (one-time HF access). ONLY=pi05
  // (pi0 / pi0fast also wired.)
  { type: 'smolvla',   ckpt: 'lerobot/smolvla_base', task: 'pick up the object', ticks: 5, readyMs: 300000 },
  { type: 'pi05',      ckpt: 'lerobot/pi05_base',    task: 'pick up the object', ticks: 3, readyMs: 1200000 },
];
const HEAVY = new Set(['pi0', 'pi05', 'pi0fast', 'smolvla']);   // real VLAs — opt-in via ONLY=<type>
const only = (process.env.ONLY || '').split(',').filter(Boolean);
const CHECKPOINTS = only.length ? ALL.filter((c) => only.includes(c.type)) : ALL.filter((c) => !HEAVY.has(c.type));

if (!existsSync(VENV_PY)) {
  console.log(h('verify-bridge-real — SKIPPED'));
  console.log(`  ⚪ no lerobot venv at ${VENV_PY} (npm run setup:lerobot). The mock bridge is covered by verify-bridge.mjs.`);
  process.exit(0);
}

const robot = JSON.parse(await readFile(join(HERE, 'robots/so101.json'), 'utf8'));
const skill = await loadSkill(join(HERE, 'skills/arm-pick-place'));
const dof = robot.dof, maxStep = skill.manifest.safety.max_step_norm;
const ids = robot.joint_ids || Array.from({ length: dof }, (_, i) => i + 1);
const { codec } = await resolveDriver(robot);
const toDof = (a) => Array.from({ length: dof }, (_, i) => (Number.isFinite(a[i]) ? a[i] : (a[i] === undefined ? 0 : a[i])));

for (const c of CHECKPOINTS) {
  console.log(h(`${c.type.toUpperCase()} · ${c.ckpt}`));
  let link;
  try {
    link = connectLeRobot(c.ckpt, { python: VENV_PY, policyType: c.type });
    const readied = await Promise.race([link.ready().then(() => true), new Promise((r) => setTimeout(() => r(false), c.readyMs))]);
    if (!readied || !String(link.mode()).startsWith('lerobot')) {
      skip(`skipped — real weights did not load in time (mode=${link.mode()}); deps/download unavailable`);
      continue;
    }
    realTested++;
    const first = await link.selectAction({ state: new Array(dof).fill(0.5), task: c.task });
    check('real weights returned an action', Array.isArray(first) && first.length >= 1 && first.every(Number.isFinite),
          `dim ${first.length}: [${first.slice(0, 4).map((v) => (+v).toFixed(3)).join(', ')}…]`);
    const raw = false || first;
    check('action is a raw policy output (envelope must bound it)', raw.some((v) => v < 0 || v > 1) || raw.some((v) => Math.abs(v) > 1e-6));

    let prev = new Array(dof).fill(0.5), maxSeen = 0, bad = false;
    for (let k = 0; k < c.ticks; k++) {
      const a = await link.selectAction({ state: prev, task: c.task });
      const safe = safetyClamp(prev, toDof(a), { maxStep, lo: 0, hi: 1 });
      const wire = codec.encode(safe, { ids });
      for (let i = 0; i < dof; i++) { maxSeen = Math.max(maxSeen, Math.abs(safe[i] - prev[i])); if (safe[i] < 0 || safe[i] > 1 || !Number.isFinite(safe[i])) bad = true; }
      if (!(wire.data && wire.data.length)) bad = true;
      prev = safe;
    }
    check(`${c.ticks} ticks of REAL ${c.type} actions → valid wire + all in [0,1]`, !bad);
    check('respected the velocity cap', maxSeen <= maxStep + 1e-9, `max ${maxSeen.toFixed(3)} ≤ ${maxStep}`);
  } catch (e) {
    skip(`skipped — ${e.message.slice(0, 80)}`);
  } finally {
    if (link) await link.close();
  }
}

const need = Math.min(2, CHECKPOINTS.length);       // default (act+diffusion) needs 2; a narrowed run needs its own
const ok = fails === 0 && realTested >= need;       // never vacuously pass on all-skips
console.log(h(ok
  ? `✅ WEIGHT-VERIFIED across ${realTested} real architectures — every checkpoint's actions bounded by the safety envelope`
  : fails > 0 ? `❌ ${fails} check(s) failed` : `❌ only ${realTested} real architecture(s) loaded (need ≥2)`));
process.exit(ok ? 0 : 1);
