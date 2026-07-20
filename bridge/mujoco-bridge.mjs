// mujoco-bridge — Node client for the MuJoCo physics server. Spawns mujoco_server.py, sends normalized
// joint commands, gets back the physics-stepped joint state — so the skillpack runtime can be evaluated
// against real rigid-body dynamics.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePython } from './python.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function connectMuJoCo({ python } = {}) {
  const proc = spawn(resolvePython(python), [resolve(HERE, 'mujoco_server.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', mode = 'unknown';
  const waiters = [];
  proc.stdout.on('data', (d) => {
    buf += d; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.shift(); if (w) w.resolve(msg);
    }
  });
  let ready; const readyP = new Promise((res) => { ready = res; });
  proc.stderr.on('data', (d) => { const s = d.toString(); const m = s.match(/mode=(\S+)/); if (m) mode = m[1]; if (/ready ·/.test(s)) ready(); });
  const rpc = (obj) => new Promise((resolve) => { waiters.push({ resolve }); proc.stdin.write(JSON.stringify(obj) + '\n'); });

  return {
    ready: () => readyP,
    mode: () => mode,                                   // 'mujoco:5dof' when physics loaded, else 'unavailable'
    reset: (q0) => rpc({ method: 'reset', q0 }),        // -> { qpos, tip }
    step: (cmd) => rpc({ method: 'step', cmd }),        // -> { qpos, tip } after physics substeps
    async close() { try { await rpc({ method: 'shutdown' }); } catch {} proc.kill(); },
  };
}
