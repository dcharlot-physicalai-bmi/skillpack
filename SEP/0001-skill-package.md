# SEP-0001: The skill package format

- **Status:** Accepted
- **Author(s):** Institute for Physical AI @ BMI
- **Created:** 2026-07-19
- **Targets spec version:** 0.2

## Summary

Define a robot skill as a directory — a policy reference, a typed contract, a capability manifest, a
safety envelope, and an eval — that installs as source, negotiates against a robot's capabilities before
it moves, and runs any policy under a runtime-enforced safety envelope.

## Motivation

The embodied stack has model hubs (LeRobot), a structure format (URDF), and a tool protocol (MCP), but no
open, cross-vendor way to package a *skill* so it is portable and safe to install. Vendor app stores fill
the gap with walls: one skill, one robot, a binary you cannot inspect. SEP-0001 is the open alternative.

## Specification

A skill is a directory with `skill.json` conforming to `schema/skill.schema.json`:

- `policy` — `kind` ∈ {analytic, vla, lerobot, mlp}; `ref` (local adapter) or `checkpoint` (lerobot).
- `requires` — `morphology`, `min_dof`, `actuation`, `sensors`, matched against a robot manifest by
  `matchRobot()` **before** any command is issued.
- `safety` — `max_step_norm`, `clamp`, enforced by the runtime, not the policy.
- `contract` — `pre`, `post`, `invariants` (the guarantees the skill makes).
- `eval` — a reproducible check with a threshold and an `environment`.

Transport is resolved from the robot manifest's `driver.target` against an external driver registry.

## Safety impact

This SEP *establishes* the safety envelope as part of the standard: the runtime clamps every proposed
action (per-tick velocity cap, `[0,1]`, NaN rejection), so a wrong or hijacked policy cannot exceed it.
This is the load-bearing invariant; later SEPs that touch it inherit the burden of proof.

## Compatibility

Initial version; nothing to migrate. Skills declare the spec version they target.

## Reference implementation

`skillkit.mjs` (runtime), `skillcore.mjs` (pure logic), `bin/skillpack.mjs` (CLI), the reference skills,
and the four verify harnesses (`verify`, `verify-vla`, `verify-cli`, `verify-flywheel`).

## Alternatives considered

- **A vendor app store** (UniStore-style): rejected — walled, single-vendor, binary.
- **A ROS package**: rejected as the primary unit — ROS is middleware, not a portable safe-skill contract,
  though a skill's transport can target ROS 2.
- **Extending URDF**: rejected — URDF describes structure, not skills; skillpack references it instead.
