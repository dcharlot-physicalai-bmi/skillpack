# Skillpack — an open, hardware-agnostic robot-skill package (v0.2)

**Opening #1 from `docs/AGENTIC-PHYSICAL-AI.md`, made real.** The "shadcn for robot skills": a skill is
**readable source you own**, not a binary locked to one vendor's arm. This is the prototype of the format.

A skill is a directory. It composes the four things the analogy map says the embodied stack has but never
standardized together:

```
skills/arm-reach/
  skill.json     ← manifest: what it does · what robot it needs · its safety envelope · its contract
  policy.mjs     ← the POLICY layer — a forward fn. Analytic baseline here; swap for a LeRobot checkpoint.
  eval.json      ← the EVAL layer — reproducible episodes + a pass threshold (VLA-REPLICA in miniature)
```

The two remaining layers are resolved at install time, not shipped in the skill:
- **capabilities** — `requires{}` in the manifest, matched against a robot's capability manifest
  (`robots/*.json`) so a registry can answer *"will this run on MY robot?"* **before** anything moves.
- **transport** — resolved from the robot manifest's `driver.target` against the **existing** Forge
  driver registry (`drivers/hwbridge.js`, 17 targets × 12 codecs). We already own this
  layer; the skillpack just binds to it.

## Why this shape

| Agentic-software primitive | Skillpack piece |
|---|---|
| Model layer (swap the model in one line) | `policy` block — `kind: "analytic" \| "mlp" \| "lerobot"`, one `ref` |
| Tool-calling contract (typed pre/post) | `contract` block — pre / post / invariants |
| "Will this run?" capability negotiation | `requires` ↔ `robots/*.json` via `matchRobot()` |
| Durable-runtime **safety envelope** | `safety` block — enforced by the RUNTIME, not the policy |
| Observability / eval | `eval` block — reproducible, thresholded |
| The transport (we already own it) | `driver.target` → `hwbridge` codec |

## The load-bearing idea: the safety envelope lives in the runtime, not the policy

A skill *proposes* actions; the **runtime clamps them**. Per-tick joint step is capped
(`safety.max_step_norm`), every command is clamped to `[0,1]`, NaNs are rejected. This is what makes an
*open* skill registry safe: **even a wrong — or hijacked (`AgentRob`) — policy cannot exceed the
envelope.** The eval proves it by running a deliberately adversarial policy through the runtime and
checking the wire output is still bounded.

## Verify

```
node v2/skillpack/verify.mjs
```

Runs the whole chain with **no hardware**: capability gating (arm skill ✓ on SO-101 / Dynamixel / Maestro
arms, ✗ on a TurtleBot with reasons) → bind to SO-101 → policy → runtime safety clamp → real Feetech
codec → validated wire packets → eval success ≥ threshold → the adversarial-policy safety proof.

## Swapping the policy (the thesis)

The reference `arm-reach` ships an analytic P-controller so the eval is deterministic. To run a trained
policy, change **one block**:

```jsonc
"policy": { "kind": "lerobot", "ref": "hf://lerobot/act_so101_reach", "observation": ["images","state"], "action": "q_cmd" }
```

Same contract *guarantees* (post-conditions + invariants), same safety envelope, same transport, same eval
metric. That is the "switch the policy in one line" abstraction the model layer is missing — provided here
by the skill contract, not the model.

**Proven, not asserted.** `skills/arm-reach-vla/` is the analytic `arm-reach` with the policy swapped for a
**real SmolVLA (450M) adapter** (`policy.smolvla.mjs`, written against the shipped `smolvla.js` interface).
`node v2/skillpack/verify-vla.mjs` shows: the manifest diff touches only the **policy** and its **sensor
needs** (a VLA needs a camera, not an IK'd `target_pose`) — safety, contract-guarantees, transport, io, and
eval-metric are byte-identical; capability gating now **rejects the Maestro arm** that ran the baseline
(no camera); a SmolVLA action chunk flows through the **same** runtime envelope to a **valid Feetech
packet**; action-chunking re-infers once per 50 ticks; and — the point — an **out-of-distribution / hijacked
VLA output is still bounded** by the runtime. The 450M weights run in-browser on WebGPU; the Node harness
validates the contract + safety wrapping with a stand-in forward pass (`webgpuBackend()` is the real
in-browser path).

## v0.2 — the `policy.kind` enum and LeRobot composition

The registry now spans five skills across three policy kinds, all under the same contract, safety envelope,
and transport. `policy.kind` is an open enum:

| `policy.kind` | what `policy.ref` resolves | inference in production | example skill |
|---|---|---|---|
| `analytic` | a local `.mjs` proposing actions | runs anywhere (deterministic) | `arm-reach`, `gripper-grasp` |
| `vla` | a local VLA adapter | on-device (WebGPU) | `arm-reach-vla` (SmolVLA 450M) |
| `lerobot` | the shared `policies/lerobot.mjs` + a `policy.checkpoint` | a LeRobot runtime (`.select_action`) | `arm-pick-place` (ACT), `arm-stack` (Diffusion) |

**LeRobot composition — the flywheel.** LeRobot standardized the policy interface (`.select_action(obs)` is
shared by ACT, DiffusionPolicy, TDMPC2, VQ-BeT, SmolVLA, π0), so **one adapter drives any checkpoint.** A
`lerobot` skill is almost entirely a *contract*: the policy block is just a checkpoint string.

```jsonc
"policy": { "kind": "lerobot", "ref": "../../policies/lerobot.mjs",
            "checkpoint": "hf://lerobot/act_so101_pickplace", "architecture": "ACT", "chunking": 100 }
```

Swap the string for `hf://lerobot/diffusion_so101_stack` and you have a Diffusion-Policy skill — same
adapter, same contract, same envelope. That is why adding skills does **not** add attack surface:
`verify-flywheel.mjs` drives **every** registry skill (analytic · vla · lerobot), on a compatible robot,
through the runtime envelope — and proves the invariants hold for all of them, including under a
hijacked/OOD policy. Growth is safe by construction.

New in v0.2: `io.action_space` is explicit on every skill; `policy.checkpoint` + `policy.architecture` for
`lerobot`; `policy.chunking` (action-horizon) for chunked policies; `eval.environment`
(`lerobot-runtime` / `browser-webgpu`) for skills whose eval runs outside the Node harness.
