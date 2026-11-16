// Guards for the committed docs/openapi.json (run by `pnpm docs:openapi`, so CI and local runs both check it).
// 1. No `example` / `examples` keywords: generated examples can carry realistic-looking ids, hosts or secrets.
// 2. No response schema property named like a secret: the API must never echo stored secrets back, and a new
//    route that starts doing so should fail CI rather than ship a documented secret field.
// 3. `servers` is the fixed localhost placeholder, never a real host picked up from someone's .env.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specPath = process.argv[2] ?? path.join(root, 'docs/openapi.json');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));

const SECRET_NAME = /token|secret|api[-_]?key|password/i;
const EXPECTED_SERVERS = JSON.stringify([{ url: 'http://localhost:3001' }]);
const problems = [];

if (JSON.stringify(spec.servers ?? []) !== EXPECTED_SERVERS) {
  problems.push(`servers must be ${EXPECTED_SERVERS}, got ${JSON.stringify(spec.servers)}`);
}

/** Walks any JSON value; `inProperties` means `node` is a schema `properties` map, whose keys are field names. */
function findExampleKeys(node, at, inProperties = false) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => findExampleKeys(item, `${at}[${i}]`));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (!inProperties && (key === 'example' || key === 'examples'))
      problems.push(`"${key}" keyword at ${at}`);
    findExampleKeys(value, `${at}.${key}`, !inProperties && key === 'properties');
  }
}
findExampleKeys(spec, '$');

function resolveRef(ref) {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce(
      (node, part) => (node === undefined ? undefined : node[part.replace(/~1/g, '/').replace(/~0/g, '~')]),
      spec,
    );
}

/** Collects every property name reachable from a schema (nested objects, arrays, combinators, $refs). */
function findSecretFields(schema, at, seen = new Set()) {
  if (schema === null || typeof schema !== 'object') return;
  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return;
    seen.add(schema.$ref);
    findSecretFields(resolveRef(schema.$ref), `${at}->${schema.$ref}`, seen);
  }
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    if (SECRET_NAME.test(name)) problems.push(`secret-named response field "${name}" at ${at}`);
    findSecretFields(sub, `${at}.${name}`, seen);
  }
  for (const key of ['items', 'additionalProperties', 'not'])
    findSecretFields(schema[key], `${at}.${key}`, seen);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    (schema[key] ?? []).forEach((sub, i) => findSecretFields(sub, `${at}.${key}[${i}]`, seen));
  }
}

for (const [route, methods] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(methods)) {
    for (const [status, response] of Object.entries(op?.responses ?? {})) {
      for (const [type, media] of Object.entries(response?.content ?? {})) {
        findSecretFields(media.schema, `${method.toUpperCase()} ${route} ${status} ${type}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`${specPath} failed ${problems.length} check(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
process.stdout.write(
  `${path.relative(root, specPath)}: no examples, no secret-named response fields, placeholder servers.\n`,
);
