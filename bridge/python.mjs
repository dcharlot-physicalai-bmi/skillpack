// python — resolve a MODERN Python interpreter for the bridges. LeRobot needs >= 3.12, and some
// systems (notably macOS) ship an ancient `python3` (3.9) on PATH that we must never fall back to.
// Prefers the venv's interpreter, then the newest named `python3.N`, and refuses < 3.12.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = [3, 12];

function versionOf(exe) {
  const r = spawnSync(exe, ['-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  const [maj, min] = r.stdout.trim().split('.').map(Number);
  return Number.isFinite(maj) && Number.isFinite(min) ? [maj, min] : null;
}
const ok = (v) => v && (v[0] > MIN[0] || (v[0] === MIN[0] && v[1] >= MIN[1]));

// Resolve the interpreter to spawn. Order: explicit override → venv → newest python3.N → bare python3
// (only if it is itself modern). Throws with a clear message rather than silently using an old one.
export function resolvePython(override) {
  if (override) return override;                                        // caller passed one explicitly
  const venv = join(HERE, '..', '.venv-lerobot', 'bin', 'python');
  if (existsSync(venv)) return venv;
  for (const name of ['python3.14', 'python3.13', 'python3.12', 'python3']) {
    const v = versionOf(name);
    if (ok(v)) return name;
  }
  throw new Error(`no Python >= ${MIN.join('.')} found (LeRobot requires it; run: npm run setup:lerobot). ` +
    `Refusing to fall back to an old system python3.`);
}
