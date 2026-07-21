# skillpack safety case

A safety layer is only trustworthy if it says exactly what it does — and, just as importantly, what it does
**not** do. This is the threat model for the skillpack runtime envelope. Every guarantee below is backed by
a verify in `npm test`; every non-guarantee is *also* pinned by a test (`verify-safety-case.mjs`), so the
claims here cannot quietly drift into overclaiming.

This is a **test-backed engineering safety case, not a formal proof.** It maps to ISO 10218-1:2025 §5.x
(power-and-force-limiting, protective stops) at the level of per-actuator command bounding.

## What the runtime guarantees

| # | Guarantee | Enforced by | Verified by |
|---|-----------|-------------|-------------|
| **G1** | Every command is within the declared per-joint range `[lo, hi]`. | `safetyClamp` range clamp | `verify`, `conformance` (RT-ENVELOPE-CLAMP) |
| **G2** | No per-tick change exceeds the declared rate cap (velocity/accel/torque-rate). | `safetyClamp` rate cap | `conformance` (RT-STEP-CAP) |
| **G3** | No NaN/±Inf from a policy ever reaches the wire. | non-finite → hold previous | `conformance` (RT-NAN-REJECT) |
| **G4** | `estop`/`reset` return a safe command (zero for symmetric spaces, hold for position). | runtime lifecycle | `conformance` (RT-ESTOP, RT-RESET-HOME) |
| **G5** | A skill the robot can't support is refused *before any motion*, with reasons. | `matchRobot` capability gate | `verify`, `verify-agent` |
| **G6** | Installed source is byte-identical to what the author published. | content digest | `verify-integrity` |
| **G7** | No plan an (untrusted) agent emits can escape G1–G5. | `agent` guards + envelope | `verify-agent` |
| **G8** | The safety math is identical across implementations and languages. | pure arithmetic | `verify-interop`, `verify-crosslang` |

The load-bearing property: **G1–G4 hold even against a hijacked policy** — the envelope lives in the
runtime, not the policy, so a compromised, buggy, or adversarial policy is still bounded.

## What the runtime does NOT guarantee (and who owns it)

These are **out of scope by design**. Stating them is not a weakness; conflating them is the danger.

| # | NOT guaranteed | Why it's out of scope | The layer that owns it |
|---|----------------|-----------------------|------------------------|
| **N1** | **Task correctness.** A command can be perfectly in-range and rate-limited yet *wrong for the task*. The envelope does not know the goal. | The envelope bounds motion, not intent. | the planner + `eval` (and a human) |
| **N2** | **Inter-joint / self-collision / workspace collision** — *for robots without a geometry model.* The bare envelope bounds each joint independently and models no geometry, so on its own it permits any in-range configuration, including colliding ones. | No kinematic/geometric model in the envelope itself. | the optional collision layer below, when a geometry model is declared |

### N2 — now an *optional* guard (`collision.mjs`)

For a robot that declares a `geometry` model, the collision layer (`collision.mjs`) adds a **protective-stop
guard** layered *on top of* the envelope: minimal forward kinematics + self-collision, floor, and keep-out
checks. Before a command would enter a colliding configuration, the guard **halts** (holds the last
collision-free config). This is a real, verified upgrade — but its scope is precise, and stated honestly:

- It applies **only to robots that declare a geometry model**. `hasGeometry(robot)` reports whether the
  guarantee is available; robots without one get *no* collision guarantee (N2 stays out of scope for them),
  and `verify-collision.mjs` pins that.
- The shipped geometry supports both a **2D planar** and a **3D spatial** (rotation-per-joint) chain, on
  didactic robots — enough to make the checks concrete and verifiable, with capsule links + AABB keep-outs.
  It is *not* a claim of full 3D **mesh** collision or a real robot's measured dimensions.
- It pairs with a **planner** (`planning.mjs`): a seeded RRT that finds a collision-free path *around* the
  obstacle (every config and edge verified clear), so following the plan avoids tripping the protective stop.
  The planner returns a guaranteed-safe path, **not** a shortest/optimal one; it plans in normalized joint
  space via the collision checker, so it works unchanged for both the 2D and 3D geometry models. Full 3D
  **mesh** collision and optimal planning remain future work.
| **N3** | **Dynamic stability on hardware.** In-range, rate-capped commands are *kinematic* bounds; they are not a guarantee of dynamic stability, traction, or balance on a real body. | The runtime is not a dynamics model. | controller tuning + hardware commissioning + the sim eval |
| **N4** | **Perception / sensor integrity.** A spoofed or wrong observation can make an honest policy choose a bad — but still in-range — action. The envelope bounds the *action*, not the *truth of the input*. | The envelope sees commands, not the world. | perception + sensor attestation |
| **N5** | **Hard real-time timing.** The JS/Python runtimes give *logical* command bounds, not hard real-time deadlines. | Host runtimes aren't RTOSes. | the target's own control loop |
| **N6** | **Formal verification.** The guarantees are test-backed, not machine-checked proofs. | Scope/cost. | future formal work, if warranted |

## Reporting

Found a case where a guarantee (G1–G8) does not hold? That is a security issue — open an issue titled
`SAFETY:` with a reproduction. A case that falls under N1–N6 is expected behavior, not a vulnerability.
