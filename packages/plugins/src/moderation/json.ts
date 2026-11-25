import type { Prisma } from '@pavisie/database';

/**
 * Turns case metadata into a Prisma-writable JSON value with exactly the semantics the database layer already
 * applied (it serializes JSON columns with `JSON.stringify`): `undefined` properties are dropped, a Date becomes
 * its ISO string, a non-finite number becomes `null`.
 *
 * Deliberately never stricter than that. `createCase` runs after Discord has already applied the action, so
 * rejecting a value here would leave a real action with no case and no audit row.
 */
export function toInputJsonValue(value: object): Prisma.InputJsonValue {
  // `JSON.parse` of a `JSON.stringify`'d object is, by construction, a JSON object, so this cast is exact.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}
