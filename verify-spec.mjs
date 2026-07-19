// verify-spec.mjs — every skill.json and the registry validate against the published JSON Schemas.
// A dependency-free subset validator (type · required · enum · pattern · min/max · items · properties):
// enough to hold the spec honest without pulling a validator library.
//   node v2/skillpack/verify-spec.mjs

import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = async (p) => JSON.parse(await readFile(resolve(HERE, p), 'utf8'));

// minimal JSON-Schema (draft-2020 subset) validator → array of error strings
function validate(data, schema, path = '') {
  const errs = [];
  const t = schema.type;
  const typeOk = (v, ty) => ty === 'integer' ? Number.isInteger(v)
    : ty === 'number' ? typeof v === 'number'
    : ty === 'array' ? Array.isArray(v)
    : ty === 'object' ? (v && typeof v === 'object' && !Array.isArray(v))
    : typeof v === ty;
  if (t && !typeOk(data, t)) { errs.push(`${path || '<root>'}: expected ${t}, got ${Array.isArray(data) ? 'array' : typeof data}`); return errs; }
  if (schema.enum && !schema.enum.includes(data)) errs.push(`${path}: "${data}" not in [${schema.enum.join(', ')}]`);
  if (schema.pattern && typeof data === 'string' && !new RegExp(schema.pattern).test(data)) errs.push(`${path}: "${data}" fails /${schema.pattern}/`);
  if (typeof data === 'number') {
    if (schema.minimum != null && data < schema.minimum) errs.push(`${path}: ${data} < min ${schema.minimum}`);
    if (schema.maximum != null && data > schema.maximum) errs.push(`${path}: ${data} > max ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && data <= schema.exclusiveMinimum) errs.push(`${path}: ${data} ≤ exclusiveMin ${schema.exclusiveMinimum}`);
  }
  if (t === 'object' && data) {
    for (const req of schema.required || []) if (!(req in data)) errs.push(`${path}: missing required "${req}"`);
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in data) errs.push(...validate(data[k], sub, `${path}.${k}`));
  }
  if (t === 'array' && Array.isArray(data)) {
    if (schema.minItems != null && data.length < schema.minItems) errs.push(`${path}: ${data.length} < minItems ${schema.minItems}`);
    if (schema.maxItems != null && data.length > schema.maxItems) errs.push(`${path}: ${data.length} > maxItems ${schema.maxItems}`);
    if (schema.items) data.forEach((v, i) => errs.push(...validate(v, schema.items, `${path}[${i}]`)));
  }
  return errs;
}

let fails = 0;
const check = (n, errs) => { const ok = errs.length === 0; console.log(`  ${ok ? '✅' : '❌'} ${n}`); if (!ok) { errs.forEach((e) => console.log(`      ${e}`)); fails += errs.length; } };
const h = (s) => `\n\x1b[1m${s}\x1b[0m`;

const skillSchema = await load('schema/skill.schema.json');
const regSchema = await load('schema/registry.schema.json');
const registry = await load('registry.json');

console.log(h('registry.json vs schema/registry.schema.json'));
check('registry validates', validate(registry, regSchema));

console.log(h(`${registry.skills.length} skill manifests vs schema/skill.schema.json`));
for (const s of registry.skills) {
  const manifest = await load(join(s.path, 'skill.json'));
  check(`${s.name}/skill.json validates`, validate(manifest, skillSchema));
  // cross-check: registry entry agrees with the manifest it points at
  const drift = [];
  if (manifest.name !== s.name) drift.push(`name "${manifest.name}" ≠ registry "${s.name}"`);
  if (manifest.policy.kind !== s.policy) drift.push(`policy "${manifest.policy.kind}" ≠ registry "${s.policy}"`);
  if (manifest.requires.min_dof !== s.requires.min_dof) drift.push(`min_dof ${manifest.requires.min_dof} ≠ registry ${s.requires.min_dof}`);
  check(`${s.name} registry entry matches its manifest`, drift);
}

console.log(h(fails === 0
  ? `✅ spec verified — registry + all ${registry.skills.length} skills conform to the schemas, no registry/manifest drift`
  : `❌ ${fails} schema error(s)`));
process.exit(fails === 0 ? 0 : 1);
