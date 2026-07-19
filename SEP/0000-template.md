# SEP-XXXX: <title>

- **Status:** Draft | Accepted | Rejected | Superseded
- **Author(s):**
- **Created:**
- **Targets spec version:**

## Summary

One paragraph: what changes, in one sentence a robotics engineer would understand.

## Motivation

What is broken or missing today? Who feels it? Why now?

## Specification

The precise change. Include schema deltas (`schema/*.json`), new manifest fields, or runtime behavior.
Be exact enough that two independent implementations would agree.

## Safety impact

Every SEP must answer this. Does the change touch the runtime safety envelope, the capability
negotiation, or the transport? If it weakens any invariant, justify it and state the mitigation. A SEP
that expands what a skill can command carries the burden of proof.

## Compatibility

Backward compatibility, migration path, and the deprecation plan (if any).

## Reference implementation

Link to the PR. A SEP is not accepted without one, plus passing `verify-spec.mjs` and
`verify-flywheel.mjs`.

## Alternatives considered

What else was on the table, and why this.
