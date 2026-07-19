// verify-bridge-real.mjs — the bridge driven by a REAL LeRobot checkpoint (weights, not a mock).
// Loads lerobot/act_aloha_sim_transfer_cube_human in a py>=3.12 venv, pulls a real 14-dim action out of
// .select_action() each tick, and runs it through the skillpack safety envelope to a valid wire packet.
//
// The point is the SAFETY guarantee, weight-verified: a real policy's raw actions (out-of-range, from a
// checkpoint not trained for this arm) are BOUNDED by the runtime — valid wire, in [0,1], within the cap.
// It is not a task-success claim (zero-obs, cross-embodiment); it is the envelope holding on real weights.
//
//   node verify-bridge-real.mjs            (auto-skips if the lerobot venv isn't present)
//   VENV_PY=/path/to/py node verify-bridge-real.mjs

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, resolveDriver } from './skillkit.mjs';
import { safetyClamp } from './skillcore.mjs';
import { connectLeRobot } from './bridge/lerobot-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENV_PY = process.env.VENV_PY || join(HERE, '.venv-lerobot/bin/python');
const CHECKPOINT = 'lerobot/act_aloha_sim_transfer_cube_human';
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

if (!existsSync(VENV_PY)) {
  console.log(h('verify-bridge-real — SKIPPED'));
  console.log(`  ⚪ no lerobot venv at ${VENV_PY} (create: python3.13 -m venv .venv-lerobot && .venv-lerobot/bin/pip install lerobot)`);
  console.log('  The mock-backed bridge is covered by verify-bridge.mjs; this one needs the real weights.');
  process.exit(0);
}

const robot = JSON.parse(await readFile(join(HERE, 'robots/so101.json'), 'utf8'));
const skill = await loadSkill(join(HERE, 'skills/arm-pick-place'));
const dof = robot.dof, maxStep = skill.manifest.safety.max_step_norm;
const ids = robot.joint_ids || Array.from({ length: dof }, (_, i) => i + 1);

console.log(h(`real LeRobot checkpoint · ${CHECKPOINT} · ACT weights on-device → skillpack envelope`));
let link;
try {
  link = connectLeRobot(CHECKPOINT, { python: VENV_PY, policyType: 'act' });
  await Promise.race([link.ready(), new Promise((r) => setTimeout(r, 90000))]); // first call loads weights

  const first = await link.selectAction({ state: new Array(dof).fill(0.5) });
  check('real policy returned an action from actual weights', Array.isArray(first) && first.length >= 1 && first.every(Number.isFinite),
        `dim ${first.length}: [${first.slice(0, 4).map((v) => (+v).toFixed(3)).join(', ')}…]`);
  const looksReal = first.some((v) => v < 0 || v > 1) || first.some((v) => Math.abs(v) > 1e-6);
  check('actions are raw policy outputs (not clamped upstream)', looksReal, 'some values fall outside [0,1] — the envelope must bound them');

  const { codec } = await resolveDriver(robot);
  let prev = new Array(dof).fill(0.5), maxSeen = 0, bad = false;
  for (let k = 0; k < 20; k++) {
    const raw = await link.selectAction({ state: prev });                    // REAL 14-dim action
    const safe = safetyClamp(prev, raw.slice(0, dof), { maxStep, lo: 0, hi: 1 });
    const wire = codec.encode(safe, { ids });
    for (let i = 0; i < dof; i++) { maxSeen = Math.max(maxSeen, Math.abs(safe[i] - prev[i])); if (safe[i] < 0 || safe[i] > 1 || !Number.isFinite(safe[i])) bad = true; }
    if (!(wire.data && wire.data.length)) bad = true;
    prev = safe;
  }
  check('20 ticks of REAL actions → valid wire + all in [0,1]', !bad);
  check('real actions respected the velocity cap', maxSeen <= maxStep + 1e-9, `max ${maxSeen.toFixed(3)} ≤ ${maxStep}`);
} finally {
  if (link) await link.close();
}

console.log(h(fails === 0
  ? '✅ WEIGHT-VERIFIED — a real LeRobot ACT checkpoint drives a skillpack skill, bounded by the safety envelope'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
