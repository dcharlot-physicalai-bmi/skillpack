// verify-authoring.mjs — the author→publish loop: new → validate → build-registry → installable.
// Runs in a throwaway copy of the package so it never touches the real registry.
//   node v2/skillpack/verify-authoring.mjs

import { cp, mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');

// copy only what the author/maintainer commands need (never the venv/node_modules/git)
const tmp = await mkdtemp(join(tmpdir(), 'skillpack-author-'));
for (const p of ['bin', 'skills', 'robots', 'policies', 'drivers', 'schema', 'skillkit.mjs', 'skillcore.mjs', 'integrity.mjs', 'registry.json']) {
  if (existsSync(join(HERE, p))) await cp(join(HERE, p), join(tmp, p), { recursive: true });
}
// skillkit resolves the hwbridge driver from either the repo's drivers/ or the site's islands lib. The
// site-embedded tree has no local drivers/, so make the throwaway self-contained: copy whichever
// hwbridge this tree actually uses into <tmp>/drivers/ (the first place skillkit looks).
if (!existsSync(join(tmp, 'drivers/hwbridge.js'))) {
  const hb = [join(HERE, 'drivers/hwbridge.js'), join(HERE, '../public/assets/islands/lib/hwbridge.js')].find(existsSync);
  if (hb) { await mkdir(join(tmp, 'drivers'), { recursive: true }); await cp(hb, join(tmp, 'drivers/hwbridge.js')); }
}
const CLI = join(tmp, 'bin/skillpack.mjs');
const run = (args) => { const r = spawnSync('node', [CLI, ...args], { cwd: tmp, encoding: 'utf8' }); return { out: strip(r.stdout) + strip(r.stderr), code: r.status }; };
const origSkills = JSON.parse(await readFile(join(tmp, 'registry.json'), 'utf8')).skills.length;

console.log(h(`author → publish · throwaway copy (${origSkills} skills to start)`));

console.log(h('1 · skillpack new — scaffold a skill you own'));
const n = run(['new', 'my-grasp', '--morphology', 'arm', '--dof', '5']);
check('new scaffolds skills/my-grasp/', n.code === 0 && existsSync(join(tmp, 'skills/my-grasp/skill.json')));
check('scaffold includes a policy + eval', existsSync(join(tmp, 'skills/my-grasp/policy.mjs')) && existsSync(join(tmp, 'skills/my-grasp/eval.json')));

console.log(h('2 · skillpack validate — schema + capability + the SAFETY GATE'));
const v = run(['validate', './skills/my-grasp']);
check('the scaffolded skill validates', v.code === 0 && /valid/.test(v.out));
check('validate ran the safety gate (hijacked policy bounded)', /safety envelope holds/.test(v.out));

console.log(h('3 · validate REJECTS an unsafe/invalid skill'));
await mkdir(join(tmp, 'skills/broken'), { recursive: true });
await writeFile(join(tmp, 'skills/broken/skill.json'), JSON.stringify({ name: 'broken', version: '0.1.0', policy: { kind: 'analytic', ref: './policy.mjs' }, requires: { morphology: 'arm', min_dof: 5 }, contract: { post: [], invariants: [] } }));  // no safety{}
const vb = run(['validate', './skills/broken']);
check('a skill with no safety envelope is rejected', vb.code !== 0, (vb.out.match(/invalid:[^\n]*/) || [''])[0].trim().slice(0, 60));

console.log(h('4 · skillpack build-registry — regenerate the index from disk'));
// remove the broken dir so the registry build is clean
await rm(join(tmp, 'skills/broken'), { recursive: true, force: true });
const b = run(['build-registry']);
check('build-registry succeeds', b.code === 0 && /built registry.json/.test(b.out));
const reg = JSON.parse(await readFile(join(tmp, 'registry.json'), 'utf8'));
check('the new skill is in the regenerated registry', reg.skills.some((s) => s.name === 'my-grasp'));
check('all original skills are preserved', reg.skills.length === origSkills + 1, `${reg.skills.length} skills (was ${origSkills})`);
check('the new registry entry is well-formed', (() => { const e = reg.skills.find((s) => s.name === 'my-grasp'); return e && e.policy === 'analytic' && e.requires.min_dof === 5 && e.files.includes('skill.json'); })());

console.log(h('5 · the freshly-authored skill installs like any other'));
const proj = join(tmp, 'proj'); await mkdir(proj, { recursive: true });
const runIn = (args, cwd) => { const r = spawnSync('node', [CLI, ...args, '--registry', tmp], { cwd, encoding: 'utf8' }); return { out: strip(r.stdout) + strip(r.stderr), code: r.status }; };
runIn(['init', '--robot', 'so101'], proj);
const add = runIn(['add', 'my-grasp'], proj);
check('add installs the authored skill as source', add.code === 0 && existsSync(join(proj, 'skills/my-grasp/skill.json')));

await rm(tmp, { recursive: true, force: true });
console.log(h(fails === 0
  ? '✅ authoring verified — new → validate (safety-gated) → build-registry → installable'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
