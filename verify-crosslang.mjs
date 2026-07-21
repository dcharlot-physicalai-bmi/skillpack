// verify-crosslang.mjs — the standard is CROSS-LANGUAGE, and its safety behavior is identical across
// languages. The safety envelope is pure arithmetic (clamp + rate cap + range), so the JS runtime
// (interop/miniruntime.mjs) and the clean-room Python runtime (py/skillpack.py) must produce the SAME
// safety-bounded trajectory for the same policy proposals. This drives both with one deterministic,
// hostile-but-finite proposal sequence and asserts the trajectories match to within 1e-12.
//   node v2/skillpack/verify-crosslang.mjs
//
// (NaN/Inf rejection is verified per-language in each conformance battery; JSON can't portably carry
// NaN, so the cross-language sequence is finite — it still exercises the range clamp + rate cap fully.)

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bind as miniBind } from './interop/miniruntime.mjs';
import { resolvePython } from './bridge/python.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

let PY = null;
try { PY = resolvePython(); } catch { PY = null; }
if (!PY || !existsSync(join(HERE, 'py/skillpack.py'))) {
  console.log(h('cross-language equivalence — SKIPPED (no modern Python found)'));
  console.log('  ⚪ the JS↔Python trajectory match needs Python >= 3.12; each runtime is still self-verified.');
  process.exit(0);
}

// a deterministic, hostile-but-finite proposal sequence of the given width (out-of-range + hard jumps)
function proposals(dof, n = 60) {
  const seq = [];
  for (let k = 0; k < n; k++) {
    seq.push(Array.from({ length: dof }, (_, i) => (((k * 7 + i * 13) % 23) - 11) * 0.9 + (k % 5 === 0 ? 5 : 0) * (i % 2 ? -1 : 1)));
  }
  return seq;
}

// (0) the Python runtime passes its own conformance battery (clean-room, across the registry)
console.log(h('Python runtime conformance (clean-room)'));
const battery = spawnSync(PY, [join(HERE, 'py/skillpack.py')], { encoding: 'utf8' });
check('py/skillpack.py is skillpack-conformant on every skill', battery.status === 0,
  (battery.stdout || '').includes('conformant on every skill') ? 'all skills conformant' : (battery.stderr || battery.stdout || '').split('\n').slice(-2).join(' '));

console.log(h('cross-language equivalence — JS miniruntime vs clean-room Python runtime'));
for (const name of ['arm-reach', 'mobile-goto', 'arm-compliant-push']) {
  const manifest = JSON.parse(await readFile(resolve(HERE, 'skills', name, 'skill.json'), 'utf8'));
  const dof = manifest.requires.min_dof;
  const seq = proposals(dof);

  // JS side — drive the real shipped miniruntime with the sequence as its policy proposal.
  let k = 0;
  const skill = { manifest, policyMod: { create: () => ({ step: () => seq[k++] }) } };
  const rt = miniBind(skill, { dof }, {});
  const jsTraj = seq.map(() => rt.step({}).q);

  // Python side — same sequence through py/skillpack.py's runtime clamp.
  const r = spawnSync(PY, [join(HERE, 'py/skillpack.py'), 'clamp'], { input: JSON.stringify({ manifest, dof, proposals: seq }), encoding: 'utf8' });
  const line = (r.stdout || '').trim().split('\n').pop();
  let pyTraj;
  try { pyTraj = JSON.parse(line).trajectory; } catch { check(`${name}: python produced a trajectory`, false, (r.stderr || '').split('\n').slice(-2).join(' ')); continue; }

  let maxDiff = 0;
  for (let t = 0; t < jsTraj.length; t++) for (let i = 0; i < dof; i++) maxDiff = Math.max(maxDiff, Math.abs(jsTraj[t][i] - pyTraj[t][i]));
  check(`${name} (${manifest.requires.actuation}, ${dof}-dof) — JS and Python trajectories match`, maxDiff < 1e-12, `max |Δ| ${maxDiff.toExponential(2)} over ${jsTraj.length} ticks`);
}

console.log(h(fails === 0
  ? '✅ cross-language verified — one standard, identical safety behavior in JavaScript and Python'
  : `❌ ${fails} cross-language check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
