# Contributing to skillpack

Two kinds of contribution: **skills** (add to the registry) and **spec changes** (evolve the standard).

## Contribute a skill

A skill is source you own. To add one:

1. Create `skills/<your-skill>/` with:
   - `skill.json` — the manifest (validate against `schema/skill.schema.json`).
   - a policy: a local `policy.mjs` (analytic/vla) **or** `policy.kind: "lerobot"` + a `checkpoint`
     string using the shared `policies/lerobot.mjs` adapter.
   - `eval.json` — reproducible episodes (or `eval.environment` if it runs outside the Node harness).
2. Add an entry to `registry.json`.
3. Run the checks:
   ```
   node verify-spec.mjs       # your skill.json validates against the schema
   node verify-flywheel.mjs   # your skill binds to a compatible robot and stays inside the safety envelope
   ```
4. Open a pull request. On merge it appears in the registry automatically — install-as-source, like a
   shadcn component. (Not affiliated with or endorsed by shadcn.)

**The bar:** the skill must declare an honest capability manifest and a real safety envelope, and it must
pass `verify-flywheel.mjs` — including the adversarial pass, so a bad policy cannot break the envelope.
That check is what lets an *open* registry be a *safe* one; it is not optional.

## Add a robot

Drop a capability manifest in `robots/<name>.json` (see `schema/registry.schema.json` for the shape) and
add it to `registry.json`'s `robots` list. Its `driver.target` must name a target in the Forge driver
registry (`drivers/hwbridge.js`).

## Change the spec (SEPs)

The *standard* changes through **Specification Enhancement Proposals**. Copy `SEP/0000-template.md`, fill
it in, and open a PR. A SEP needs maintainer consensus and a working reference implementation before it is
accepted. See `GOVERNANCE.md`.

## Ground rules

- Vendor-neutral: never privilege one robot, policy vendor, or cloud.
- Compose, don't reinvent: defer to LeRobot (policies), URDF (structure), MCP (protocol).
- Apache-2.0 for code, spec, and schemas. By contributing you agree your contribution is under that license.
