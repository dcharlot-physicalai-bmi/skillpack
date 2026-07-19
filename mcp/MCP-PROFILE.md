# The Robot MCP Profile — embodiment-aware Model Context Protocol

`ros-mcp` proved you can hand an LLM a robot over MCP: discover tools, call them with JSON-RPC. But it is a
**thin passthrough** — it forwards ROS topics with no notion of what is safe. The Robot MCP Profile is
"MCP for robots done right": the same MCP surface, but every tool carries the robot's **capabilities and
safety envelope**, and the server **enforces** them so a language model cannot command the robot outside
what its body can safely do.

## The one idea

**The safety envelope is in the protocol layer, not left to the caller.** When an LLM calls `run_skill`,
the server binds the skill through the skillpack runtime — capability gate first, then the per-tick
velocity cap, workspace clamp, and NaN rejection. A model that asks for something unsafe, or a compromised
model, gets a bounded, valid trajectory or a refusal with reasons — never raw unclamped motion.

## Profile = standard MCP + two required extensions

A server implementing this profile speaks ordinary MCP (`initialize`, `tools/list`, `tools/call`) and adds:

1. **Capability metadata on every skill tool.** Each tool's description and input schema declare the
   `requires{}` (morphology, DoF, actuation, sensors) and the `safety{}` envelope of the underlying skill.
   `list_skills` returns only tools the connected robot can run; incompatible ones are reported by
   `describe_robot` with reasons — the "will this run on my robot?" answer, at the protocol boundary.

2. **A safety report on every actuation.** `run_skill` returns, alongside the trajectory, a
   `safety_report`: `{ within_cap, all_in_range, wire_valid, max_step }`. The report is the server's proof
   that the envelope was enforced. If a call would violate the envelope, the server clamps it and says so;
   it never returns motion it did not bound.

## Tools

| Tool | Purpose |
|---|---|
| `describe_robot` | the connected robot's capability manifest + which skills it can/can't run (with reasons) |
| `list_skills` | the compatible skills only, each with its contract + safety envelope |
| `skill_contract` | a skill's typed `pre` / `post` / `invariants` + `requires` + `safety` |
| `run_skill` | bind + run a skill through the safety envelope; return trajectory + `safety_report` |
| `estop` | zero-velocity hold — the command that stops motion |

## Why it matters

This is the seam between the agentic-software world (LLMs calling tools over MCP) and the physical world
(a body that can hurt someone). Putting the envelope in the protocol is what lets you connect a frontier
model to a real robot **and** an open, cross-vendor skill registry without the two multiplying risk. It is
the concrete answer to `AgentRob` (forum-agent compromise → hijacked robot): the model is never trusted
with unbounded actuation.

The reference server is `robot-mcp.mjs` (dependency-free JSON-RPC 2.0, stdio); `verify-mcp.mjs` drives it.
