// verify-bridge.mjs — a skillpack `lerobot` skill driven by actions from a REAL Python process, through
// the skillpack safety envelope. Uses the deterministic mock policy (so it runs without lerobot/torch
// installed); with `pip install lerobot`, the same bridge drives a real checkpoint unchanged.
//
// NOTE ON HONESTY: the skillpack `lerobot` adapter decodes an action chunk SYNCHRONOUSLY, but the bridge
// is async (a separate process). So this harness drives the loop directly with the runtime's own pieces —
// `safetyClamp` (skillcore) + the real hwbridge codec (via resolveDriver) — awaiting the Python action
// each tick. That is faithful: it is exactly what bind() does internally, minus the sync-only wrapper.
//   node v2/skillpack/verify-bridge.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, resolveDriver } from './skillkit.mjs';
import { safetyClamp } from './skillcore.mjs';
import { connectLeRobot } from './bridge/lerobot-bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const robot = JSON.parse(await readFile(join(HERE, 'robots/so101.json'), 'utf8'));
const skill = await loadSkill(join(HERE, 'skills/arm-pick-place'));   // policy.kind = lerobot
const dof = robot.dof, maxStep = skill.manifest.safety.max_step_norm;
const ids = robot.joint_ids || Array.from({ length: dof }, (_, i) => i + 1);

console.log(h('lerobot bridge · Node ↔ Python driving a skillpack skill through the envelope'));
let link;
try {
  link = connectLeRobot('mock');   // force the deterministic mock policy — hermetic (no weights, no torch)
  await Promise.race([link.ready(), new Promise((r) => setTimeout(r, 3000))]);

  const a0 = await link.selectAction({ state: new Array(dof).fill(0.5), q_target: [0.8, 0.3, 0.6, 0.4, 0.7] });
  check('Python bridge returns an action vector', Array.isArray(a0) && a0.length >= dof, `[${a0.slice(0, dof).map((v) => (+v).toFixed(2)).join(', ')}]`);

  const { codec } = await resolveDriver(robot);
  const target = [0.8, 0.3, 0.6, 0.4, 0.7];
  let prev = new Array(dof).fill(0.5), maxSeen = 0, bad = false, moved = false;
  for (let k = 0; k < 30; k++) {
    const raw = await link.selectAction({ state: prev, q_target: target });      // REAL action from Python
    const safe = safetyClamp(prev, raw.slice(0, dof), { maxStep, lo: 0, hi: 1 }); // runtime safety envelope
    const wire = codec.encode(safe, { ids });                                     // real hwbridge codec
    for (let i = 0; i < dof; i++) { maxSeen = Math.max(maxSeen, Math.abs(safe[i] - prev[i])); if (safe[i] < 0 || safe[i] > 1 || !Number.isFinite(safe[i])) bad = true; }
    if (!(wire.data && wire.data.length)) bad = true;
    if (Math.abs(safe[0] - 0.5) > 1e-6) moved = true;
    prev = safe;
  }
  check('30 real-bridge ticks → valid wire + all in [0,1]', !bad);
  check('the bridge actually drove the joints (not held)', moved);
  check('bridge actions respected the velocity cap', maxSeen <= maxStep + 1e-9, `max ${maxSeen.toFixed(3)} ≤ ${maxStep}`);
  const err = Math.max(...prev.map((v, i) => Math.abs(v - target[i])));
  check('converged toward the target under the envelope', err < 0.05, `final err ${err.toFixed(3)}`);
} finally {
  if (link) await link.close();
}

console.log(h(fails === 0
  ? '✅ LeRobot bridge verified — a real Python policy process drives a skillpack skill, bounded by the envelope'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
