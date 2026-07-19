# skillpack — the open, cross-vendor robot-skill layer

> **An open standard, Apache-2.0.** Spec: `SPEC.md` (v0.2) · schemas: `schema/` · governance &
> the path to a neutral foundation: `GOVERNANCE.md` · how to add a skill or change the spec:
> `CONTRIBUTING.md` + `SEP/`.

The open answer to the walled robot app store. A skill is **source you own** — a policy reference + a typed
contract + a capability manifest + a safety envelope + an eval — that **installs, checks your robot's
capabilities, and runs safely on any body.** Composes LeRobot checkpoints; rides the existing Forge driver
registry (17 hardware targets). Strategy: `../docs/AGENTIC-PHYSICAL-AI-ECOSYSTEM.md`.

## Try it

```bash
node bin/skillpack.mjs list                    # browse the registry
node bin/skillpack.mjs init --robot so101      # scaffold ./robot.json (your capability manifest)
node bin/skillpack.mjs check arm-reach         # will it run on your robot?
node bin/skillpack.mjs add arm-reach           # capability-gated install-as-source
```

The install is **capability-gated** — the twist only robots need. `skillpack add` checks the skill against
your `robot.json` and **refuses (with reasons)** if it won't run, so you never install a skill your body
can't safely execute. That is friction-zero adoption (the shadcn mechanic) plus a safety gate.

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
| `durable.mjs` | durable execution — checkpoint per waypoint, resume-without-redo, progress-aware rollback, HITL suspend |
| `bin/skillpack.mjs` | the CLI — `list · init · check · add · verify` |
| `registry.json` | the registry index (skills + sample robots) |
| `policies/lerobot.mjs` | shared adapter — drives **any** LeRobot checkpoint via `.select_action(obs)` |
| `skills/arm-reach/` | reference skill — analytic P-controller baseline |
| `skills/arm-reach-vla/` | the same skill with the policy swapped for a **real SmolVLA (450M)** |
| `skills/gripper-grasp/` | analytic grasp — needs the gripper DoF (≥5), so it gates out 4-DoF arms |
| `skills/arm-pick-place/` | composes a **LeRobot ACT** checkpoint (`hf://lerobot/act_so101_pickplace`) |
| `skills/arm-stack/` | composes a **LeRobot Diffusion Policy** checkpoint — same contract, ≥6 DoF |
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
```

All run with no robot and no GPU (SmolVLA's 450M weights run in-browser on WebGPU; the Node harness
validates the contract + safety wrapping with a stand-in forward pass).

### Weight-verified (real LeRobot checkpoint)

```
npm run setup:lerobot     # python3.13 venv + pip install lerobot  (needs Python >= 3.12)
npm run test:real         # drives a skill with a REAL lerobot ACT checkpoint through the envelope
```

`verify-bridge-real.mjs` loads `lerobot/act_aloha_sim_transfer_cube_human`, pulls a real 14-dim action out
of `.select_action()` each tick, and runs it through the skillpack safety envelope to a valid wire packet.
The real actions fall **outside** [0,1] (a checkpoint not trained for this arm) — and the runtime **bounds
them**: valid wire, in range, within the velocity cap. That is the safety guarantee, verified on real
weights. `npm run test:real` auto-skips cleanly if the lerobot venv isn't present.
