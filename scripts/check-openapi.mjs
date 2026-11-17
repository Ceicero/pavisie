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

/**
 * Field names that match SECRET_NAME but are known to be harmless counts or flags. Add a name here, with a
 * comment saying why, rather than loosening the pattern.
 */
const ALLOWED_FIELDS = new Set([]);

/** Values under these keys are data, not schemas, so their keys are never field names. */
const DATA_KEYS = new Set(['default', 'enum', 'const', 'example', 'examples']);

/**
 * Walks a schema generically: every keyword's sub-schemas (items, prefixItems, allOf/anyOf/oneOf, not, if/then/else,
 * additionalProperties, $defs, …) and $refs, checking the field names in `properties` and `patternProperties`.
 */
function findSecretFields(schema, at, seen = new Set()) {
  if (Array.isArray(schema)) {
    schema.forEach((sub, i) => findSecretFields(sub, `${at}[${i}]`, seen));
    return;
  }
  if (schema === null || typeof schema !== 'object') return;
  if (typeof schema.$ref === 'string' && !seen.has(schema.$ref)) {
    seen.add(schema.$ref);
    findSecretFields(resolveRef(schema.$ref), `${at}->${schema.$ref}`, seen);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (DATA_KEYS.has(key)) continue;
    if ((key === 'properties' || key === 'patternProperties') && value && typeof value === 'object') {
      for (const [name, sub] of Object.entries(value)) {
        if (SECRET_NAME.test(name) && !ALLOWED_FIELDS.has(name)) {
          problems.push(`secret-named response field "${name}" at ${at}`);
        }
        findSecretFields(sub, `${at}.${name}`, seen);
      }
    } else {
      findSecretFields(value, `${at}.${key}`, seen);
    }
  }
}

/** Follows `$ref`s on response, header and media objects (e.g. `#/components/responses/…`). */
function deref(node) {
  const seen = new Set();
  while (node && typeof node.$ref === 'string' && !seen.has(node.$ref)) {
    seen.add(node.$ref);
    node = resolveRef(node.$ref);
  }
  return node;
}

for (const [route, methods] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(methods ?? {})) {
    if (!op || typeof op !== 'object') continue;
    for (const [status, rawResponse] of Object.entries(op.responses ?? {})) {
      const response = deref(rawResponse);
      const at = `${method.toUpperCase()} ${route} ${status}`;
      for (const [type, media] of Object.entries(response?.content ?? {})) {
        findSecretFields(deref(media)?.schema, `${at} ${type}`);
      }
      for (const [name, header] of Object.entries(response?.headers ?? {})) {
        if (SECRET_NAME.test(name) && !ALLOWED_FIELDS.has(name))
          problems.push(`secret-named response header "${name}" at ${at}`);
        findSecretFields(deref(header)?.schema, `${at} header ${name}`);
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
