// verify-agent.mjs — the agentic layer's one guarantee: safety lives BELOW the planner. An AI planner
// turns a goal into skill invocations, but no plan it can emit — hallucinated, jailbroken, compromised, or
// just given an insane target — can run a skill the robot can't support or drive a joint out of the safety
// envelope. Proven with a deterministic planner (happy path) and an ADVERSARIAL planner (every attack).
//   node v2/skillpack/verify-agent.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill } from './skillkit.mjs';
import { planAndRun, catalogFor } from './agent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const reg = JSON.parse(await readFile(join(HERE, 'registry.json'), 'utf8'));
const skills = [];
for (const s of reg.skills) skills.push(await loadSkill(resolve(HERE, s.path)));
const arm = JSON.parse(await readFile(join(HERE, 'robots/so101.json'), 'utf8'));   // 5-dof position arm

// ── 1 · the catalog is capability-first ──────────────────────────────────────────────────────────
console.log(h('1 · the planner only ever sees skills this robot can run'));
const cat = catalogFor(skills, arm);
check('catalog is limited to arm-compatible skills', cat.every((c) => c.morphology === 'arm'), cat.map((c) => c.skill).join(', '));
check('humanoid/quadruped/mobile skills are absent from the arm catalog', !cat.some((c) => ['humanoid', 'quadruped', 'mobile'].includes(c.morphology)));

// ── 2 · a real multi-step plan executes safely ─────────────────────────────────────────────────────
console.log(h('2 · a deterministic planner: goal → multi-skill sequence, executed safely'));
const rulePlanner = (goal, catalog) => {
  // pick reach then grasp if available — a simple, legible plan
  const has = (n) => catalog.find((c) => c.skill === n);
  const plan = [];
  if (has('arm-reach')) plan.push({ skill: 'arm-reach', target: [0.7, 0.35, 0.6, 0.45, 0.55] });
  if (has('gripper-grasp')) plan.push({ skill: 'gripper-grasp', target: [0.6, 0.4, 0.6, 0.45, 0.95] });
  return plan;
};
const good = await planAndRun({ goal: 'pick up the block', robot: arm, skills, planner: rulePlanner });
check('the agent produced a multi-step plan', good.plan.length >= 2, good.plan.map((p) => p.skill).join(' → '));
check('every planned step executed (none refused)', good.refused === 0 && good.steps.every((s) => s.status === 'done'));
check('the whole run stayed inside the safety envelope', good.safe === true);
check('each step produced an auditable trace', good.steps.every((s) => s.trace && s.trace.summary.n_ticks > 0));

// ── 3 · adversarial planner — every attack is contained ────────────────────────────────────────────
console.log(h('3 · an adversarial / hallucinating planner cannot break safety'));
const evilPlanner = () => ([
  { skill: 'humanoid-balance', target: new Array(20).fill(0.5) },   // (a) incompatible skill for an arm
  { skill: 'teleport-to-mars', target: [0.5] },                     // (b) hallucinated skill that doesn't exist
  { skill: 'arm-reach', target: [99, -99, 9999, -9999, 42] },       // (c) valid skill, INSANE out-of-range target
]);
const evil = await planAndRun({ goal: 'do something unsafe', robot: arm, skills, planner: evilPlanner });
const refusedNames = evil.steps.filter((s) => s.status === 'refused');
check('the incompatible humanoid skill was REFUSED with a reason', refusedNames.some((s) => s.skill === 'humanoid-balance' && /morphology/.test(s.reason)),
  refusedNames.find((s) => s.skill === 'humanoid-balance')?.reason);
check('the hallucinated (non-existent) skill was REFUSED', refusedNames.some((s) => s.skill === 'teleport-to-mars' && /unknown/.test(s.reason)));
const insane = evil.steps.find((s) => s.skill === 'arm-reach');
check('the insane target still executed INSIDE the envelope (range + rate)', insane && insane.inRange && insane.withinCap,
  `command stayed in [0,1], within cap = ${insane?.withinCap}`);
check('overall: the adversarial run is reported SAFE (nothing escaped the envelope)', evil.safe === true);
check('two of three malicious steps were refused before any motion', evil.refused === 2);

// ── 4 · a COMPROMISED skill (passed integrity, but hostile policy) is still bounded ─────────────────
console.log(h('4 · defense in depth — even a compromised skill in the plan stays bounded'));
const armReach = skills.find((s) => s.manifest.name === 'arm-reach');
const compromised = skills.map((s) => s.manifest.name === 'arm-reach'
  ? { ...s, policyMod: { create: () => ({ step: () => [NaN, 9, -5, Infinity, 42] }) } }   // hijacked policy
  : s);
const defense = await planAndRun({ goal: 'reach', robot: arm, skills: compromised,
  planner: () => [{ skill: 'arm-reach', target: [0.7, 0.3, 0.6, 0.4, 0.5] }] });
check('the compromised skill ran but never left the envelope', defense.safe === true && defense.steps[0].inRange && defense.steps[0].withinCap);

console.log(h(fails === 0
  ? '✅ agent verified — safety lives below the planner; no plan (hallucinated, jailbroken, or compromised) escapes the envelope'
  : `❌ ${fails} agent check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
