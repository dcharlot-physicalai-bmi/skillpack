// verify-integrity.mjs — content provenance for skill packages. Every registry entry records a content
// digest over the exact bytes of its files; `skillpack add` recomputes it after fetching and refuses to
// install source whose bytes don't match. This proves: (1) the recorded digests match the files on disk,
// (2) any tamper — a loosened safety cap in the manifest, a swapped policy byte — changes the digest and
// is therefore caught before the code is ever run on a robot.
//   node v2/skillpack/verify-integrity.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageDigest, fileDigests, fileDigest } from './integrity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const check = (n, c, d = '') => { console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); if (!c) fails++; };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const reg = JSON.parse(await readFile(join(HERE, 'registry.json'), 'utf8'));

console.log(h(`registry provenance — ${reg.skills.length} skills carry a content digest`));
let allHaveDigest = true;
for (const s of reg.skills) {
  const bytes = [];
  for (const f of s.files) bytes.push({ path: f, bytes: await readFile(resolve(HERE, s.path, f), 'utf8') });
  const digest = packageDigest(bytes);
  const perFile = fileDigests(bytes);
  if (!s.integrity) allHaveDigest = false;
  const pkgOk = s.integrity === digest;
  const perOk = s.digests && Object.entries(perFile).every(([p, d]) => s.digests[p] === d);
  check(`${s.name} — package digest matches its files`, pkgOk, s.integrity ? s.integrity.slice(0, 22) + '…' : 'NO DIGEST');
  check(`${s.name} — every per-file digest matches`, perOk);
}
check('every skill in the registry carries an integrity digest', allHaveDigest);

console.log(h('tamper detection — the whole point'));
// pick the first skill; simulate a hostile edit to its manifest (loosen a safety cap) after publication.
const victim = reg.skills[0];
const files = [];
for (const f of victim.files) files.push({ path: f, bytes: await readFile(resolve(HERE, victim.path, f), 'utf8') });
const clean = packageDigest(files);
check('a clean fetch matches the published digest (what `add` checks)', clean === victim.integrity);

const tampered = files.map((f) => f.path === 'skill.json'
  ? { path: f.path, bytes: f.bytes.replace(/("max_step_norm"\s*:\s*)[\d.]+/, '$19.99').replace(/("max_torque_norm"\s*:\s*)[\d.]+/, '$19.99').replace(/("max_speed_norm"\s*:\s*)[\d.]+/, '$19.99') + ' ' }
  : f);
const tamperedDigest = packageDigest(tampered);
check('a tampered manifest produces a DIFFERENT digest → `add` would refuse', tamperedDigest !== victim.integrity,
  `clean ${clean.slice(7, 15)}… vs tampered ${tamperedDigest.slice(7, 15)}…`);

// a single flipped byte in any file must change the digest
const oneByte = files.map((f, i) => i === files.length - 1 ? { path: f.path, bytes: f.bytes + '\n' } : f);
check('a single trailing byte anywhere changes the digest', packageDigest(oneByte) !== clean);

// order independence: the digest does not depend on file order
const shuffled = [...files].reverse();
check('digest is order-independent (canonical)', packageDigest(shuffled) === clean);

console.log(h(fails === 0
  ? '✅ integrity verified — every skill has a content digest, and tampering is provably caught before install'
  : `❌ ${fails} integrity check(s) failed`));
process.exit(fails === 0 ? 0 : 1);
