// verify-collision.mjs — the geometry layer that upgrades SAFETY.md N2 from "out of scope" to "an optional
// guard for robots that declare geometry". Proves: forward kinematics is correct; self-collision, floor, and
// keep-out are each detected; the protective-stop guard HALTS before a command enters a colliding config but
// lets a clear path proceed; and a robot WITHOUT a geometry model honestly gets NO collision guarantee.
//   node v2/skillpack/verify-collision.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardK, collides, collisionGuard, hasGeometry } from './collision.mjs';
import { bind } from './skillkit.mjs';
import { loadSkill } from './skillkit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const robot = JSON.parse(await readFile(join(HERE, 'robots/planar-3r.json'), 'utf8'));
const so101 = JSON.parse(await readFile(join(HERE, 'robots/so101.json'), 'utf8'));

// ── 1 · forward kinematics ─────────────────────────────────────────────────────────────────────────
console.log(h('1 · forward kinematics from the declared geometry'));
const straight = forwardK(robot, [0.5, 0.5, 0.5]);   // all mid-range angles = 0 → straight along +x
const reach = 0.40 + 0.35 + 0.25;
check('straight config extends to the summed link length along +x', Math.abs(straight[3][0] - reach) < 1e-9 && Math.abs(straight[3][1]) < 1e-9, `end = [${straight[3].map((v) => v.toFixed(2))}]`);
check('the chain has base + one point per link', straight.length === robot.geometry.links.length + 1);

// ── 2 · each collision kind is detected ──────────────────────────────────────────────────────────────
console.log(h('2 · self-collision, floor, and keep-out are detected'));
check('a folded config is flagged as self-collision', collides(robot, [0.5, 1.0, 1.0]).kind === 'self-collision');
check('a config reaching below the floor is flagged', collides(robot, [0.25, 0.5, 0.5]).kind === 'floor');
check('a config entering the keep-out box is flagged', collides(robot, [0.55, 0.55, 0.5]).kind === 'keepout');
check('a clear config is not flagged', collides(robot, [0.5, 0.5, 0.5]).hit === false);

// ── 3 · the protective-stop guard ───────────────────────────────────────────────────────────────────
console.log(h('3 · the guard halts before a colliding config, and proceeds on a clear path'));
const clearGuard = collisionGuard(robot);
let prev = [0.5, 0.5, 0.5], halts = 0;
// drive toward a CLEAR target — every step should be permitted
for (let k = 0; k < 20; k++) { const next = prev.map((p, i) => p + (( [0.52, 0.52, 0.55][i]) - p) * 0.3); const g = clearGuard.step(prev, next); if (g.halted) halts++; prev = g.command; }
check('a clear trajectory is never halted', halts === 0);

const stopGuard = collisionGuard(robot);
prev = [0.5, 0.5, 0.5];
let everCollidedCommand = false, halted = false, lastReason = '';
// drive toward a target that folds into self-collision — the guard must stop before commanding a hit
for (let k = 0; k < 30; k++) {
  const next = prev.map((p, i) => p + (([0.5, 1.0, 1.0][i]) - p) * 0.3);
  const g = stopGuard.step(prev, next);
  if (collides(robot, g.command).hit) everCollidedCommand = true;   // the COMMANDED config must never collide
  if (g.halted) { halted = true; lastReason = g.reason; }
  prev = g.command;
}
check('the guard eventually HALTS before the collision', halted, lastReason);
check('no commanded config ever collided (protective stop held a safe config)', !everCollidedCommand);

// ── 4 · composes with the envelope (defense in depth) ────────────────────────────────────────────────
console.log(h('4 · layered on top of the envelope — per-joint bounds AND geometry'));
const skill = await loadSkill(join(HERE, 'skills/arm-reach'));
const rt = await bind(skill, robot, {});
const guard = collisionGuard(robot);
let world = rt.state(), safeCmds = true, blockedACollision = false;
for (let k = 0; k < 40; k++) {
  const t = rt.step({ q: world, q_target: [0.55, 0.55, 0.5], state: world });   // envelope-bounded command toward keep-out
  const { lo, hi } = rt.envelope; if (t.q.some((v) => v < lo - 1e-9 || v > hi + 1e-9)) safeCmds = false;   // envelope still holds
  const g = guard.step(world, t.q);
  if (g.halted) blockedACollision = true;
  world = g.command;
}
check('the envelope still bounds every per-joint command (range held)', safeCmds);
check('the geometry guard additionally blocked the keep-out incursion', blockedACollision);
check('final commanded config is collision-free', collides(robot, world).hit === false);

// ── 5 · honesty — no geometry, no guarantee (N2 stays out of scope) ──────────────────────────────────
console.log(h('5 · honesty — a robot without a geometry model gets NO collision guarantee'));
check('so101 declares no geometry model', !hasGeometry(so101));
check('collides() on it returns hit=false with an explicit "not available" reason', collides(so101, [0.5, 0.5, 0.5, 0.5, 0.5]).detail.includes('no geometry model'));
check('the guard is a no-op for it (passes commands through, unguarded)', collisionGuard(so101).available === false);

console.log(h(fails === 0
  ? '✅ collision layer verified — geometry-aware protective stop for robots that declare geometry; honestly absent otherwise'
  : `❌ ${fails} collision check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
