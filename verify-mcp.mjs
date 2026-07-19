// verify-mcp.mjs — the Robot MCP Profile end-to-end. Drives robot-mcp.mjs over JSON-RPC and proves the
// safety envelope + capability gate are enforced IN THE PROTOCOL: an LLM calling these tools cannot get
// the robot to move outside its body's safe range.
//   node v2/skillpack/verify-mcp.mjs

import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeContext, handleRequest } from './mcp/robot-mcp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;
let id = 0;
const rpc = (ctx, method, params) => handleRequest({ jsonrpc: '2.0', id: ++id, method, params }, ctx);
const toolText = (res) => JSON.parse(res.result.content[0].text);

const arm = await makeContext(join(HERE, 'robots/so101.json'));       // 5-DoF arm, Feetech, has camera
const mobile = await makeContext(join(HERE, 'robots/turtlebot.json')); // mobile base

console.log(h('robot-mcp · JSON-RPC handshake'));
const init = await rpc(arm, 'initialize', {});
check('initialize returns the robot-mcp profile', init.result?.serverInfo?.profile === 'robot-mcp/0.1', init.result?.serverInfo?.profile);
const tools = await rpc(arm, 'tools/list', {});
check('advertises the profile tools', ['describe_robot', 'list_skills', 'skill_contract', 'run_skill', 'estop'].every((t) => tools.result.tools.some((x) => x.name === t)));

console.log(h('describe_robot · capability negotiation at the protocol boundary'));
const desc = toolText(await rpc(arm, 'tools/call', { name: 'describe_robot', arguments: {} }));
const compat = desc.skills.filter((s) => s.compatible).map((s) => s.name);
const incompat = desc.skills.filter((s) => !s.compatible);
check('SO-101 exposes its compatible skills', compat.includes('arm-reach') && compat.includes('arm-pick-place'));
check('arm-stack (needs 6 DoF) reported incompatible with reasons', incompat.some((s) => s.name === 'arm-stack' && s.reasons.length), (incompat.find((s) => s.name === 'arm-stack') || {}).reasons?.join(' · '));

console.log(h('list_skills carries the safety envelope (embodiment-aware)'));
const list = toolText(await rpc(arm, 'tools/call', { name: 'list_skills', arguments: {} }));
check('every listed skill ships its safety envelope', list.skills.length > 0 && list.skills.every((s) => typeof s.safety.max_step_norm === 'number'));

console.log(h('run_skill · the envelope is ENFORCED by the server'));
const run = toolText(await rpc(arm, 'tools/call', { name: 'run_skill', arguments: { name: 'arm-reach', ticks: 40 } }));
check('run returns a safety_report', !!run.safety_report);
check('within the velocity cap, in range, wire valid', run.safety_report.within_cap && run.safety_report.all_in_range && run.safety_report.wire_valid,
      `max_step ${run.safety_report.max_step} ≤ ${run.safety_report.cap}`);

console.log(h('run_skill · a hijacked policy over MCP still cannot break the envelope'));
const hij = toolText(await rpc(arm, 'tools/call', { name: 'run_skill', arguments: { name: 'arm-reach-vla', ticks: 40, policy_override: 'corrupt' } }));
check('hijacked run stays within cap + in range + valid wire', hij.hijacked && hij.safety_report.within_cap && hij.safety_report.all_in_range && hij.safety_report.wire_valid);

console.log(h('run_skill · incompatible skill is REFUSED before any motion'));
const refuseArmOnMobile = toolText(await rpc(mobile, 'tools/call', { name: 'run_skill', arguments: { name: 'arm-reach' } }));
check('arm skill on a mobile base is refused with reasons', refuseArmOnMobile.refused === true && refuseArmOnMobile.reasons.length > 0,
      refuseArmOnMobile.reasons?.[0]);
const refuseRes = await rpc(mobile, 'tools/call', { name: 'run_skill', arguments: { name: 'arm-reach' } });
check('refusal is flagged isError at the protocol layer', refuseRes.result.isError === true);

console.log(h('errors'));
const bad = await rpc(arm, 'tools/call', { name: 'run_skill', arguments: { name: 'nope' } });
check('unknown skill → JSON-RPC error', !!bad.error);

console.log(h(fails === 0
  ? '✅ Robot MCP Profile verified — capability-gated, safety-enveloped, hijack-safe, at the protocol boundary'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
