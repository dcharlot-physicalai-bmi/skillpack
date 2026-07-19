# Governance

skillpack is an **open standard for robot skills**, seeded by the Institute for Physical AI @ BMI and
built to be handed to a neutral foundation. This document states how decisions are made and where the
project is going, so that adopting it is a safe bet.

## The intent: seed it, then give it away

The proven path for an open standard is to seed it, grow it in the open, and transfer it to a
vendor-neutral home so that even competitors can build on it without fear of capture. MCP did this in
eighteen months (Anthropic → the Agentic AI Foundation under the Linux Foundation, with OpenAI and others
as co-founders); ROS did the robotics-native version (OSRF → the Open Source Robotics Alliance:
mixed-membership, meritocratic, explicitly no venture capital). skillpack follows that path.

**An institute is the ideal neutral seeder**: it sells no robot and licenses no policy, so it has no
incentive to bias the standard toward one vendor. The Institute stewards skillpack until it is ready to
transfer to a neutral foundation, and commits to that transfer as the project matures.

## Principles

1. **Vendor-neutral.** The standard must never privilege one robot, one policy vendor, or one cloud. A
   capability manifest and a driver target describe hardware; they never name a preferred brand.
2. **Safety is not optional.** The runtime safety envelope is part of the standard, not an add-on. A
   change that weakens the envelope requires a higher bar of review.
3. **Compose, don't capture.** skillpack sits above the model layer (LeRobot), the structure format
   (URDF), and the protocol layer (MCP). It standardizes only the genuinely missing seam and defers to
   those where they already lead.
4. **Open by default.** Spec, reference implementation, schemas, and tests are Apache-2.0. Skills are
   contributed as source, not binaries.

## Decision-making

Today the project is small and decisions are made in the open by the maintainers on the issue tracker.
As it grows it adopts a lightweight, MCP-style structure:

- **Maintainers** review contributions and cut releases.
- **Specification Enhancement Proposals (SEPs)** are how the *standard* changes — see `SEP/`. Anyone may
  open a SEP; it needs maintainer consensus and a reference implementation before it is accepted.
- **Working groups** own areas (safety envelope, transport/drivers, MCP profile, eval) as the surface
  grows.

## Versioning

- The **spec** is versioned in `SPEC.md` (currently v0.2). Breaking changes bump the minor until 1.0.
- **Schemas** (`schema/*.json`) are the machine-checkable contract and are validated in CI
  (`verify-spec.mjs`).
- A skill declares the spec version it targets; the runtime supports a documented range.

## The transfer commitment

When skillpack has real adoption across more than one hardware ecosystem, the Institute will move it to a
neutral foundation (Linux Foundation / Eclipse / OSRA-class) under a mixed-membership, meritocratic model.
The goal is a standard nobody owns and everybody can build on — including the people who seeded it.
