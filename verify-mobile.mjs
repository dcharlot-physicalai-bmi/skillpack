// verify-mobile.mjs — the contract spans MORPHOLOGIES and ACTION SPACES. A velocity-controlled mobile
// base runs the same negotiation + safety principle as the arms, with a speed/acceleration envelope
// instead of a position-step one. The TurtleBot — refused by every arm skill — finally runs something.
//   node v2/skillpack/verify-mobile.mjs

import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill, matchRobot, bind } from './skillkit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const robot = async (f) => JSON.parse(await readFile(resolve(HERE, 'robots', f), 'utf8'));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const skill = await loadSkill(join(HERE, 'skills/mobile-goto'));
const m = skill.manifest;
const turtle = await robot('turtlebot.json');
const so101 = await robot('so101.json');
const maxSpeed = m.safety.max_speed_norm, maxAccel = m.safety.max_accel_norm;

console.log(h('1 · Capability negotiation across morphologies'));
check('mobile-goto RUNS on the TurtleBot (the base finally has a skill)', matchRobot(m, turtle).ok);
const onArm = matchRobot(m, so101);
check('mobile-goto is refused on an arm, with a reason', !onArm.ok, onArm.reasons.join(' · '));

console.log(h('2 · The velocity envelope (speed + acceleration), not a position step'));
const rt = await bind(skill, turtle, {});
check('runtime is in velocity mode', rt.velocity === true);
check('starts from zero velocity (not a joint pose)', rt.state().every((v) => v === 0));

console.log(h('3 · Drive a 2D base to a goal — the safety-bounded velocity integrates to the waypoint'));
// world: a holonomic 2D base. pose += velocity * dt. velocity is the bounded command.
function driveTo(q0, goal, ticks = 120, dt = 0.12) {
  const r = bind_sync();                                        // fresh runtime per run
  let pose = q0.slice(), prevV = [0, 0], maxV = 0, maxA = 0, reached = -1;
  for (let k = 0; k < ticks; k++) {
    const t = r.step({ pose, goal });
    for (let i = 0; i < 2; i++) { maxV = Math.max(maxV, Math.abs(t.q[i])); maxA = Math.max(maxA, Math.abs(t.q[i] - prevV[i])); }
    prevV = t.q;
    pose = pose.map((p, i) => Math.max(0, Math.min(1, p + t.q[i] * dt)));
    if (Math.max(Math.abs(pose[0] - goal[0]), Math.abs(pose[1] - goal[1])) < 0.03 && reached < 0) reached = k + 1;
  }
  return { pose, reached, maxV, maxA };
  function bind_sync() { return rtCache; }
}
// bind is async; make one runtime and reuse via closure per episode
let rtCache;
const eps = skill.evalSpec.episodes;
let passed = 0, worstV = 0, worstA = 0;
for (const ep of eps) {
  rtCache = await bind(skill, turtle, {});
  const out = driveTo(ep.q0, ep.q_target);
  worstV = Math.max(worstV, out.maxV); worstA = Math.max(worstA, out.maxA);
  if (out.reached > 0) passed++;
}
check('reaches the goal on ≥ 7/8 episodes', passed >= 7, `${passed}/${eps.length} reached`);
check('commanded speed never exceeded max_speed_norm', worstV <= maxSpeed + 1e-9, `max |v| ${worstV.toFixed(3)} ≤ ${maxSpeed}`);
check('velocity change never exceeded max_accel_norm', worstA <= maxAccel + 1e-9, `max |Δv| ${worstA.toFixed(3)} ≤ ${maxAccel}`);

console.log(h('4 · A hijacked mobile policy stays inside the velocity envelope'));
const evil = { ...skill, policyMod: { create: () => ({ step: () => [NaN, 9999] }) } };
const rtE = await bind(evil, turtle, {});
let vbad = false, aSeen = 0, prevV = [0, 0];
for (let k = 0; k < 40; k++) {
  const t = rtE.step({ pose: [0.5, 0.5], goal: [0.9, 0.9] });
  for (let i = 0; i < 2; i++) { aSeen = Math.max(aSeen, Math.abs(t.q[i] - prevV[i])); if (!Number.isFinite(t.q[i]) || Math.abs(t.q[i]) > maxSpeed + 1e-9) vbad = true; }
  if (!(t.wire && t.wire.data && t.wire.data.length)) vbad = true;
  prevV = t.q;
}
check('garbage velocities (NaN, 9999) bounded to the speed limit + valid wire', !vbad);
check('acceleration limit held under the hijack', aSeen <= maxAccel + 1e-9, `max |Δv| ${aSeen.toFixed(3)} ≤ ${maxAccel}`);

console.log(h('5 · estop is zero velocity (stop), not a held pose'));
check('estop returns zero velocity', rt.estop().every((v) => v === 0));

console.log(h(fails === 0
  ? '✅ cross-morphology verified — a velocity mobile base runs the same contract, bounded by a speed/accel envelope'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
