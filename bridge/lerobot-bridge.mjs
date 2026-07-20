// lerobot-bridge — Node client for the Python LeRobot bridge server. Spawns lerobot_server.py, speaks
// line-delimited JSON, and exposes a backend `{ selectAction(obs) }` that plugs straight into the
// skillpack `lerobot` policy adapter. This is how a `lerobot` skill gets driven by a REAL checkpoint
// running in a LeRobot (Python) runtime — while the skillkit safety envelope, on this side, bounds it.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePython } from './python.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function connectLeRobot(checkpoint = 'mock', { python, policyType = 'act' } = {}) {
  const args = [resolve(HERE, 'lerobot_server.py'), '--checkpoint', checkpoint, '--policy-type', policyType];
  const proc = spawn(resolvePython(python), args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = [];
  proc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }   // ignore stray non-JSON on stdout
      const w = waiters.shift();
      if (w) w.resolve(msg);
    }
  });
  let ready = null, mode = 'unknown';
  const readyP = new Promise((res) => { ready = res; });
  proc.stderr.on('data', (d) => { const s = d.toString(); const m = s.match(/mode=(\S+)/); if (m) mode = m[1]; if (/ready ·/.test(s)) ready(); });

  const rpc = (obj) => new Promise((resolve, reject) => { waiters.push({ resolve, reject }); proc.stdin.write(JSON.stringify(obj) + '\n'); });

  return {
    ready: () => readyP,
    mode: () => mode,                    // 'lerobot:<type>' when real weights loaded, else 'mock'
    // the backend the lerobot adapter expects
    async selectAction(obs) {
      const state = obs && (obs.state || obs.q);
      const target = obs && obs.q_target;
      const task = obs && obs.task;
      const r = await rpc({ method: 'select_action', obs: { state, target, task } });
      return r.action;
    },
    reset: () => rpc({ method: 'reset' }),
    async close() { try { await rpc({ method: 'shutdown' }); } catch {} proc.kill(); },
  };
}
