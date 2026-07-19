// arm-reach-vla · POLICY layer — a REAL SmolVLA (450M VLA) behind the same policy interface.
//
// This is the "swap the policy in one line" proof: skillkit binds this exactly like the analytic
// baseline — `create(skill, robot, opts) -> { reset(), step(obs) -> action }` — and the SAME runtime
// safety envelope + transport wrap it. The only difference is what produces the action.
//
// The 450M weights run in-browser on WebGPU (onnxruntime-web); this adapter shares the REAL config and
// I/O contract from the shipped smolvla.js. Inference is injected as `opts.backend` so:
//   • in the browser, the island passes a backend that calls a loaded `new SmolVLA(...).sampleActions()`
//   • in the Node harness, a deterministic backend stands in for the forward pass (WebGPU absent),
//     letting us validate the contract + safety mapping without the GPU.
//
// SmolVLA emits an ACTION CHUNK (chunkSize × maxActionDim). We consume it with action chunking:
// re-infer only when the chunk is spent — the standard VLA deployment pattern.

import { SMOLVLA_CFG } from '../../policies/smolvla.js';

// Build the real in-browser backend (used when WebGPU is available). Kept here so the integration
// lives with the skill; the Node harness never calls this path.
export function webgpuBackend({ baseUrl, tokenizeFn, preprocessImageFn, onStatus } = {}) {
  let model = null;
  return {
    async load() {
      const { SmolVLA } = await import('../../policies/smolvla.js');
      model = new SmolVLA({ baseUrl, device: 'webgpu', onStatus });
      await model.load();
    },
    async infer(obs) {
      const images = preprocessImageFn(obs.image);           // 512×512 RGB, normalized (real I/O)
      const { ids, mask } = await tokenizeFn(obs.task);
      const state = padState(obs.state, SMOLVLA_CFG.maxActionDim);
      return model.sampleActions({
        images, imgMasks: [1], langTokens: ids, langMasks: mask, state,
      });                                                     // Float32Array[chunk*maxActionDim]
    },
  };
}

function padState(state, dim) {
  const out = new Float32Array(dim);
  for (let i = 0; i < Math.min(state ? state.length : 0, dim); i++) out[i] = state[i];
  return out;
}

export function create(skill, robot, opts = {}) {
  const dof = robot.dof;
  const cfg = SMOLVLA_CFG;
  const backend = opts && opts.backend;
  if (!backend || typeof backend.infer !== 'function')
    throw new Error('arm-reach-vla needs a SmolVLA inference backend (opts.backend.infer). ' +
      'In-browser: webgpuBackend({...}); in tests: a stand-in backend.');
  let chunk = null, cursor = 0;

  return {
    reset() { chunk = null; cursor = 0; },
    // obs = { image, task, state }. Returns the raw VLA action for this timestep (dof values).
    // The action is UNTRUSTED — VLAs can emit out-of-range / spiky values under distribution shift.
    // The runtime safety envelope (in skillkit) is what makes that safe; the policy never clamps.
    step(obs) {
      if (!chunk || cursor >= cfg.chunkSize) {               // action chunking
        chunk = backend.infer(obs);                          // Float32Array[chunk*maxActionDim]
        cursor = 0;
      }
      const base = cursor * cfg.maxActionDim;
      const a = new Array(dof);
      for (let i = 0; i < dof; i++) a[i] = chunk[base + i];   // first `dof` action dims of this step
      cursor++;
      return a;
    },
  };
}
