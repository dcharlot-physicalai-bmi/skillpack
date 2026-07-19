// skillkit — the open robot-skill runtime. Load a skill package, negotiate it against a robot's
// capability manifest, resolve a transport from the EXISTING Forge driver registry, and bind a
// runtime that wraps ANY policy in a safety envelope. No framework lock-in; readable source.
//
// The single source of truth for transports is hwbridge.js (17 targets × 12 codecs) — we already
// own it. skillkit does not reimplement codecs; it binds to them.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSkill, matchRobot, safetyClamp } from './skillcore.mjs';

export { validateSkill, matchRobot, safetyClamp };

// hwbridge.js is browser ESM; it only touches navigator/window lazily (inside .supported()/connect),
// so a tiny shim lets us import the PURE codec table in Node.
globalThis.navigator ??= {};
globalThis.window ??= {};
const HERE = dirname(fileURLToPath(import.meta.url));
const HWBRIDGE = resolve(HERE, 'drivers/hwbridge.js');

let _hw = null;
export async function driverRegistry() {
  if (!_hw) _hw = await import(pathToFileURL(HWBRIDGE).href);
  return { CODECS: _hw.CODECS, TARGETS: _hw.TARGETS, normalize: _hw.normalize };
}

// ── load & validate ──────────────────────────────────────────────────────────
export async function loadSkill(dir) {
  const manifest = JSON.parse(await readFile(resolve(dir, 'skill.json'), 'utf8'));
  validateSkill(manifest);
  // Import any policy adapter shipped as local source (analytic baseline OR a VLA/lerobot wrapper).
  // A remote ref (hf://…, https://…) has no local module — the adapter is resolved by the deployment.
  const ref = manifest.policy.ref || '';
  const local = ref.startsWith('.') || ref.startsWith('/');
  const policyMod = local ? await import(pathToFileURL(resolve(dir, ref)).href) : null;
  let evalSpec = null;
  if (manifest.eval?.ref) evalSpec = JSON.parse(await readFile(resolve(dir, manifest.eval.ref), 'utf8'));
  return { dir, manifest, policyMod, evalSpec };
}

// validateSkill · matchRobot · safetyClamp now live in skillcore.mjs (re-exported above) so the CLI
// and the in-browser demo share the exact same logic.

// ── transport resolution against the real driver registry ──
export async function resolveDriver(robot) {
  const { CODECS, TARGETS } = await driverRegistry();
  const target = TARGETS.find((t) => t.id === robot.driver?.target);
  if (!target) throw new Error(`no driver target "${robot.driver?.target}" in the registry`);
  const codec = CODECS[target.codec];
  if (!codec) throw new Error(`registry target "${target.id}" names unknown codec "${target.codec}"`);
  return { target, codec };
}

// The runtime safety envelope (safetyClamp) is imported from skillcore.mjs and re-exported above.

// Bind skill × robot × policy → a runtime. `q0` is the homed start config (normalized).
// `policyOpts` is forwarded to the policy adapter (e.g. a SmolVLA inference backend).
export async function bind(skill, robot, { q0, policyOpts } = {}) {
  const m = skill.manifest;
  const { target, codec } = await resolveDriver(robot);
  const { normalize } = await driverRegistry();
  const dof = robot.dof;
  // envelope params depend on the action space. position → clamp [0,1], cap the per-tick step (a velocity
  // limit). velocity → symmetric clamp [-speed, speed] (a speed limit) + cap the per-tick change (an accel
  // limit), starting from zero velocity. Same safetyClamp, different bounds — the contract generalizes.
  const velocity = m.requires.actuation === 'velocity';
  const maxStep = velocity ? m.safety.max_accel_norm : m.safety.max_step_norm;
  const [lo, hi] = velocity ? [-m.safety.max_speed_norm, m.safety.max_speed_norm] : (m.safety.clamp || [0, 1]);
  const home = () => (velocity ? new Array(dof).fill(0) : (q0 ? q0.slice() : new Array(dof).fill(0.5)).slice(0, dof));
  const policy = skill.policyMod.create(m, robot, policyOpts);
  let prev = home();

  return {
    target, codec, velocity,
    envelope: { lo, hi, maxStep },   // exposed so a tracer can classify each intervention (clamp/cap/hold)
    reset(q) { prev = velocity ? new Array(dof).fill(0) : (q ? q.slice() : new Array(dof).fill(0.5)).slice(0, dof); policy.reset?.(); },
    state: () => prev.slice(),
    // one control tick: obs → policy proposal → safety envelope → normalized → wire bytes
    step(obs) {
      const proposed = policy.step(obs);                                   // untrusted proposal
      const safe = safetyClamp(prev, proposed, { maxStep, lo, hi });       // envelope (position or velocity)
      prev = safe;
      // the codec speaks a 0..1 range; velocity in [-speed,speed] maps to 0..1 (0.5 = stop)
      const wireVals = velocity ? safe.map((v) => (v - lo) / ((hi - lo) || 1)) : safe;
      const t = normalize(wireVals, wireVals.map(() => [0, 1]));
      const ids = robot.joint_ids || safe.map((_, i) => i + 1);
      const wire = codec.encode(t, { ids });
      return { q: safe.slice(), proposed, wire };
    },
    estop() { return velocity ? new Array(dof).fill(0) : prev.slice(); },  // velocity: stop; position: hold
  };
}

// ── eval: run reproducible episodes through the BOUND runtime (envelope engaged) ──
export async function runEval(skill, robot) {
  const spec = skill.evalSpec;
  if (!spec) throw new Error('no eval spec');
  const tol = spec.tolerance, maxTicks = spec.max_ticks;
  const results = [];
  let maxStepSeen = 0, allInRange = true;
  for (const ep of spec.episodes) {
    const rt = await bind(skill, robot, { q0: ep.q0 });
    let prev = ep.q0.slice(), ticks = 0, ok = false;
    for (let k = 0; k < maxTicks; k++) {
      const { q } = rt.step({ q: rt.state(), q_target: ep.q_target });
      for (let i = 0; i < q.length; i++) {
        maxStepSeen = Math.max(maxStepSeen, Math.abs(q[i] - prev[i]));
        if (q[i] < 0 || q[i] > 1 || !Number.isFinite(q[i])) allInRange = false;
      }
      prev = q; ticks = k + 1;
      const err = Math.max(...q.map((v, i) => Math.abs(v - ep.q_target[i])));
      if (err < tol) { ok = true; break; }
    }
    results.push({ ok, ticks });
  }
  const passed = results.filter((r) => r.ok).length;
  return { total: results.length, passed, rate: passed / results.length, maxStepSeen, allInRange, results };
}
