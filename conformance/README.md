# skillpack conformance

**The standard is the test suite.** A vendor, framework, or hobbyist can call something
"skillpack-compatible" only if it passes this battery. The requirements here are the executable form of
[`SPEC.md`](../SPEC.md): each one carries its normative **MUST** text, the spec section it comes from,
and a test that runs against a *pluggable* implementation — so you certify **your** runtime and **your**
skills, not just this repo's.

## Two levels

| Level | What it certifies | Fixture you supply |
|-------|-------------------|--------------------|
| **Skill** | A skill package declares a well-formed contract + safety envelope + eval, and gates onto robots by capability. | `{ skill, robot, core: { validateSkill, matchRobot } }` |
| **Runtime** | A runtime bounds **any** policy — including a hijacked one — inside the declared envelope, and offers a safe estop/reset. | adds `runtime: { bind }` |

Runtime conformance is the load-bearing one: it is checked by driving a **deliberately hijacked policy**
(NaN, ±Inf, wildly out-of-range) and asserting the runtime keeps every command inside the declared range
and rate cap, and never lets NaN reach the wire. A conformant runtime is safe *even when the policy is
compromised* — which is the whole thesis (the envelope lives in the runtime, not the policy).

## The requirements

Skill level:
- **SKILL-MANIFEST** — required fields + a well-formed safety envelope.
- **SKILL-SAFETY-DECL** — an action-space envelope matching the actuation (position→`max_step`, velocity→`max_speed`+`max_accel`, torque→`max_torque`+`max_torque_rate`).
- **SKILL-REQUIRES** — `requires{morphology, min_dof, actuation}` so a robot is gated before motion.
- **SKILL-CONTRACT** — a typed contract: pre-conditions, post-conditions, invariants.
- **SKILL-EVAL** — an eval with an environment and a metric.
- **SKILL-CAP-GATE** — capability matching accepts a compatible robot and refuses an under-provisioned one, *with reasons*.

Runtime level:
- **RT-ENVELOPE-CLAMP** — a hijacked policy is bounded inside the declared range every tick; a well-formed wire command is always emitted.
- **RT-STEP-CAP** — the per-tick change never exceeds the declared rate cap.
- **RT-NAN-REJECT** — NaN/Inf never propagate from a policy to the wire.
- **RT-ESTOP** — `estop()` returns a command inside the safe range (zero for symmetric velocity/torque spaces).
- **RT-RESET-HOME** — `reset()` returns to a safe home state inside the range.
- **RT-SYMMETRIC-ZERO** — a symmetric (velocity/torque) runtime starts from zero command. *(n/a for position skills.)*

## Run it

```bash
# certify one skill (skill + runtime levels) on a capability-matched sample robot
skillpack conformance skills/arm-compliant-push

# run the full battery against the reference implementation, over every skill in the registry
skillpack conformance            # or: npm run test  (it's part of the suite)
node verify-conformance.mjs --report   # print every requirement's result
```

## Certify your own implementation

The runner takes your implementation as arguments — nothing here is hard-wired to this repo:

```js
import { conformanceReport } from '@physicalai-bmi/skillpack/conformance/run.mjs';

const report = await conformanceReport({
  skill,                                  // a loaded skill package
  robot,                                  // a capability-matched robot manifest
  core:    { validateSkill, matchRobot }, // YOUR validator + capability matcher
  runtime: { bind },                      // YOUR runtime — bind(skill, robot, opts) → { envelope, step, estop, reset, state, symmetric }
});

report.conformant;  // boolean
report.results;     // [{ id, level, must, spec, status, detail }]
```

A conformant `bind` must return a runtime exposing at least: `envelope:{lo,hi,maxStep}`, `symmetric`,
`step(obs)→{q,wire}`, `estop()`, `reset()`, `state()`. If yours does, and it passes this battery, it is
skillpack-conformant — and your skills will interoperate with everyone else's.

## Is the battery real? (interop validation)

A conformance suite that nothing can fail is theater. [`interop/miniruntime.mjs`](../interop/miniruntime.mjs)
is a **second, clean-room runtime** that shares no code with the reference `skillkit` — its own envelope
math, clamp, and wire encoder. [`verify-interop.mjs`](../verify-interop.mjs) proves both directions:

- **(A) Independence** — `miniruntime` passes the runtime battery across position, velocity, and torque, so
  "skillpack-conformant" is a real, portable contract, not a description of one codebase.
- **(B) Teeth** — a set of runtimes each broken in exactly one way (no clamp, no rate cap, NaN leak, bad
  estop, bad reset, symmetric non-zero start) are each *caught by the intended requirement*.

Both run in `npm test`, so the standard's own tests are continuously validated.

## Cross-language — one standard, identical safety behavior

Robotics is Python-first, so the standard can't be a JavaScript artifact. [`py/skillpack.py`](../py/skillpack.py)
is a **third, clean-room runtime in Python** (its own envelope math, clamp, wire encoder — no shared code)
that passes the same runtime battery across the whole registry. And because the safety envelope is pure
arithmetic, the JS and Python runtimes produce the **same** safety-bounded trajectory for the same inputs:
[`verify-crosslang.mjs`](../verify-crosslang.mjs) drives both with one deterministic hostile sequence and
confirms the trajectories are **bit-identical** (`max |Δ| = 0`) across position, velocity, and torque. One
standard; the same safety guarantee whether you run it in Node or Python. (Both run in `npm test`, guarded
to skip cleanly where no Python ≥ 3.12 is present.)
