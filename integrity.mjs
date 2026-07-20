// integrity — content provenance for skill packages. A skill is SOURCE YOU RUN on hardware, so "is the
// code I fetched the code the author published?" is a safety question, not just a packaging one: the
// safety envelope trusts the manifest's own caps, so a TAMPERED manifest (loosened caps) or a swapped
// policy defeats it. The digest here is what `skillpack add` verifies after fetching, and what the
// registry records at build time — a subresource-integrity for robot skills.
//
// Digest = sha256 over a canonical, order-independent serialization of the package's files:
//   for each file, sorted by path:  "<path>\n<sha256-of-bytes>\n"
// so it is stable regardless of file order or platform, and any byte change in any file changes it.

import { createHash } from 'node:crypto';

const norm = (b) => (typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b));

// Digest of a single file's bytes → "sha256:<hex>".
export function fileDigest(bytes) {
  return 'sha256:' + createHash('sha256').update(norm(bytes)).digest('hex');
}

// Package digest over [{ path, bytes }] → "sha256:<hex>". Order-independent (paths are sorted).
export function packageDigest(files) {
  const lines = files
    .map((f) => `${f.path}\n${fileDigest(f.bytes)}\n`)
    .sort();
  return 'sha256:' + createHash('sha256').update(lines.join(''), 'utf8').digest('hex');
}

// Per-file map { path: "sha256:<hex>" } — recorded alongside the package digest so a mismatch can be
// localized to the offending file.
export function fileDigests(files) {
  const out = {};
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) out[f.path] = fileDigest(f.bytes);
  return out;
}
