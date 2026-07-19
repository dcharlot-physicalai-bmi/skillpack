// verify-hosted.mjs — the registry, served over HTTP, installs skills into a fresh project from the URL.
// This is the distribution mechanism: `skillpack add <skill> --registry <url>` from anywhere, no clone.
// Auto-skips if the hosted registry isn't reachable (offline / not yet deployed).
//   node verify-hosted.mjs            (defaults to the live Institute registry)
//   REGISTRY_URL=http://localhost:8787/assets/skillpack node verify-hosted.mjs

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, 'bin/skillpack.mjs');
const URL = process.env.REGISTRY_URL || 'https://physicalai-bmi.org/assets/skillpack';
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;
const strip = (s) => (s || '').replace(/\x1b\[[0-9;]*m/g, '');
const run = (args, cwd) => { const r = spawnSync('node', [CLI, ...args, '--registry', URL], { cwd, encoding: 'utf8' }); return { out: strip(r.stdout) + strip(r.stderr), code: r.status }; };

console.log(h(`hosted registry · ${URL}`));
let reachable = false;
try { const r = await fetch(URL + '/registry.json'); reachable = r.ok; } catch {}
if (!reachable) {
  console.log('  ⚪ SKIPPED — the hosted registry is not reachable (offline or not yet deployed).');
  console.log('  The CLI URL path is covered locally by verify-cli.mjs; this needs the live endpoint.');
  process.exit(0);
}

const reg = await (await fetch(URL + '/registry.json')).json();
check('registry.json served over HTTP', Array.isArray(reg.skills) && reg.skills.length > 0, `${reg.skills.length} skills`);

const proj = await mkdtemp(join(tmpdir(), 'skillpack-hosted-'));
const list = run(['list'], proj);
check('skillpack list works against the URL', /arm-reach/.test(list.out) && /mobile-goto/.test(list.out));
run(['init', '--robot', 'so101'], proj);
check('init pulled a robot manifest from the URL', existsSync(join(proj, 'robot.json')));
const add = run(['add', 'arm-reach'], proj);
check('skillpack add installed a skill FROM THE URL as source', add.code === 0 && existsSync(join(proj, 'skills/arm-reach/skill.json')),
      'skills/arm-reach/ fetched over HTTP');
const manifest = JSON.parse(await readFile(join(proj, 'skills/arm-reach/skill.json'), 'utf8'));
check('the installed manifest is intact', manifest.name === 'arm-reach' && manifest.policy && manifest.safety);
await rm(proj, { recursive: true, force: true });

console.log(h(fails === 0
  ? '✅ hosted registry verified — install-as-source over HTTP, from anywhere'
  : `❌ ${fails} check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
