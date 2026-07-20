# skillpack — the open, cross-vendor robot-skill layer

[![CI](https://github.com/dcharlot-physicalai-bmi/skillpack/actions/workflows/ci.yml/badge.svg)](https://github.com/dcharlot-physicalai-bmi/skillpack/actions/workflows/ci.yml)

> **An open standard, Apache-2.0.** Spec: `SPEC.md` (v0.2) · schemas: `schema/` · governance &
> the path to a neutral foundation: `GOVERNANCE.md` · how to add a skill or change the spec:
> `CONTRIBUTING.md` + `SEP/`.

The open answer to the walled robot app store. A skill is **source you own** — a policy reference + a typed
contract + a capability manifest + a safety envelope + an eval — that **installs, checks your robot's
capabilities, and runs safely on any body.** Composes LeRobot checkpoints; rides the existing Forge driver
registry (17 hardware targets). Strategy: `../docs/AGENTIC-PHYSICAL-AI-ECOSYSTEM.md`.

## Try it

Install skills from the **hosted registry** — no clone needed, from anywhere:

```bash
R=https://physicalai-bmi.org/assets/skillpack
node bin/skillpack.mjs list                 --registry $R   # browse the hosted registry
node bin/skillpack.mjs init --robot so101   --registry $R   # scaffold ./robot.json (your capability manifest)
node bin/skillpack.mjs check arm-reach      --registry $R   # will it run on your robot?
node bin/skillpack.mjs add arm-reach        --registry $R   # capability-gated install-as-source, over HTTP
```

(Omit `--registry` to use this repo's local tree.)

The install is **capability-gated** — the twist only robots need. `skillpack add` checks the skill against
your `robot.json` and **refuses (with reasons)** if it won't run, so you never install a skill your body
can't safely execute. That is friction-zero adoption (the shadcn mechanic) plus a safety gate.

**Author a skill** (the other half of the loop):

```bash
node bin/skillpack.mjs new my-grasp --morphology arm --dof 5   # scaffold skills/my-grasp/ (manifest + policy + eval)
node bin/skillpack.mjs validate ./skills/my-grasp             # schema + capability + the SAFETY GATE
node bin/skillpack.mjs build-registry                         # regenerate registry.json, then open a PR
```

`validate` runs the same safety gate the registry does: it drives a **hijacked policy** through your skill's
runtime and confirms the envelope still bounds it. A skill that can't hold the envelope doesn't validate —
so an open registry only ever grows with skills that are safe by construction.

**Live demo:** open `demo.html` — pick a robot, watch the registry gate skills against it, install one and
run its policy through the safety envelope to real wire bytes, then *corrupt the policy* and watch the
envelope hold.

## What's here

| File | Role |
|---|---|
| `SPEC.md` | the open skill-package format (v0.1) |
| `skillcore.mjs` | pure logic — validate · **capability negotiation** · **safety envelope** (one source of truth) |
| `skillkit.mjs` | the Node runtime — loader, transport binding to `hwbridge`, `bind()` |
| `evalkit.mjs` | recovery-aware evaluation — closed-loop dynamics + disturbances → success, recovery, stability, failure taxonomy |
| `bridge/mujoco_server.py` | physics-in-the-loop — a real MuJoCo rigid-body arm the runtime drives (`npm run test:mujoco`) |
| `durable.mjs` | durable execution — checkpoint per waypoint, resume-without-redo, progress-aware rollback, HITL suspend |
| `telemetry.mjs` | auditable run-trace — records every safety intervention (hold/clamp/cap), serializable + replayable |
| `record.mjs` + `bridge/record_dataset.py` | record skill executions as a real LeRobotDataset (closes the learn loop) |
| `composite.mjs` | composite skills — a skill built from registered sub-skills, gated + safety-enveloped per step, durable |
| `fleet.mjs` | multi-robot coordination — barrier-synced heterogeneous fleet, per-robot safety isolation |
| `bin/skillpack.mjs` | the CLI — `list · init · check · add · verify` |
| `registry.json` | the registry index (skills + sample robots) |
| `policies/lerobot.mjs` | shared adapter — drives **any** LeRobot checkpoint via `.select_action(obs)` |
| `skills/arm-reach/` | reference skill — analytic P-controller baseline |
| `skills/arm-reach-vla/` | the same skill with the policy swapped for a **real SmolVLA (450M)** |
| `skills/gripper-grasp/` | analytic grasp — needs the gripper DoF (≥5), so it gates out 4-DoF arms |
| `skills/arm-pick-place/` | composes a **LeRobot ACT** checkpoint (`hf://lerobot/act_so101_pickplace`) |
| `skills/arm-stack/` | composes a **LeRobot Diffusion Policy** checkpoint — same contract, ≥6 DoF |
| `skills/mobile-goto/` | a **velocity**-action-space skill for a mobile base — the contract spans morphologies |
| `skills/quadruped-trot/` | a **12-DoF CPG trot** — the contract spans legged robots (rhythmic, phase-correct, enveloped) |
| `skills/humanoid-balance/` | a **20-DoF whole-body balance** (capture-point ankle/hip) — the contract spans humanoids |
| `skills/arm-compliant-push/` | a **torque/impedance** skill — the third actuation type; the envelope is a force limit |
| `robots/*.json` | sample robot capability manifests |
| `demo.html` | the live in-browser showcase (also at physicalai-bmi.org/research/skillpack) |

## The load-bearing idea

The **safety envelope lives in the runtime, not the policy.** A skill *proposes* actions; `skillkit` clamps
them (per-tick velocity cap, `[0,1]`, NaN rejection). So even a wrong — or hijacked — policy cannot exceed
the envelope. That is what makes an *open* registry safe, and it maps onto ISO 10218-1:2025 functional safety.

## Verify (no hardware)

```bash
node verify.mjs          # contract end-to-end: gating → bind → envelope → real Feetech packet → eval → adversarial
node verify-vla.mjs      # the policy swap: analytic → real SmolVLA, same contract/safety/transport
node verify-cli.mjs      # the CLI: list → init → check → capability-gated add → install-as-source
node verify-flywheel.mjs # the WHOLE registry (analytic · vla · lerobot) stays inside one safety envelope
node verify-spec.mjs     # every skill.json + registry conform to the JSON schemas (no drift)
node verify-mcp.mjs      # the Robot MCP Profile: safety enforced in the protocol, hijack-safe
node verify-bridge.mjs   # a real Python policy process drives a skill, bounded by the envelope
node verify-eval.mjs     # recovery-aware eval: passes the capable, measures recovery, catches the under-capable
node verify-durable.mjs  # durable execution: checkpoint, resume-without-redo, HITL suspend, progress-aware rollback
node verify-mobile.mjs   # cross-morphology: a velocity mobile base under a speed/accel envelope, same contract
node verify-telemetry.mjs # every safety intervention recorded; trace serializable + replayable
node verify-composite.mjs # skills compose (reach → grasp → carry), gated + enveloped per step, durable
node verify-record.mjs    # the learning loop: record a skill run -> a real LeRobotDataset (envelope-clean), ready to train
node verify-quadruped.mjs # legged morphology: a 12-DoF CPG trot, gated + enveloped, rhythmic + phase-correct
node verify-humanoid.mjs  # humanoid morphology: a 20-DoF capture-point balance, CoM kept in the support polygon
node verify-fleet.mjs      # multi-robot: a heterogeneous 2-arm handoff, per-robot safety isolation
node verify-authoring.mjs # the author->publish loop: new -> validate (safety-gated) -> build-registry -> installable
```

All run with no robot and no GPU (SmolVLA's 450M weights run in-browser on WebGPU; the Node harness
validates the contract + safety wrapping with a stand-in forward pass).

### Weight-verified across real LeRobot architectures

```
npm run setup:lerobot     # python3.13 venv + pip install lerobot diffusers transformers  (Python >= 3.12)
npm run test:real         # drives skills with REAL lerobot checkpoints through the envelope
```

`verify-bridge-real.mjs` loads **real checkpoints of different architectures** and, each tick, pulls a real
action out of `.select_action()` and runs it through the skillpack safety envelope to a valid wire packet.
**Weight-verified across four architectures:**

- **ACT** — `lerobot/act_aloha_sim_transfer_cube_human` (14-dim action)
- **Diffusion Policy** — `lerobot/diffusion_pusht` (2-dim action)
- **SmolVLA** — `lerobot/smolvla_base`, a 450M VLA (6-dim action), open tokenizer — `ONLY=smolvla npm run test:real`
- **π0.5** — `lerobot/pi05_base`, a 3B VLA (32-dim action) — `ONLY=pi05 npm run test:real`

The real actions fall **outside** [0,1] (checkpoints not trained for this arm) — and the runtime **bounds
them**: valid wire, in range, within the velocity cap. The safety guarantee, weight-verified across
architectures. Each checkpoint runs only if its real weights actually load (the bridge reports the mode);
otherwise it's skipped honestly, never faked. (SmolVLA is the same model skillpack runs in-browser on
WebGPU — the same policy verified two ways.)

The VLAs are heavier (download + slower inference), so they're opt-in (`ONLY=smolvla` / `ONLY=pi05`); the
default `npm run test:real` runs ACT + Diffusion and auto-skips cleanly without the venv. SmolVLA's tokenizer
is open; the π-family's is the gated `google/paligemma-3b-pt-224` repo (one-time HF access approval).

### Physics-in-the-loop (real MuJoCo dynamics)

```
npm run test:mujoco       # a skill drives a real MuJoCo arm through the safety envelope
```

`verify-mujoco.mjs` drives a **real MuJoCo 5-DoF rigid-body arm** (gravity, inertia, joint coupling) with the
skill's safety-bounded commands and measures success on the **physical** joint state — not the kinematic
approximation `evalkit.mjs` uses. The arm reaches its targets under real dynamics, every command stays within
the velocity cap, and a hijacked policy cannot drive the physical arm out of bounds. Auto-skips without the
venv (`npm run setup:lerobot` installs `mujoco`).
