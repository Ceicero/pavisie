/**
 * Connection-pool sizing for the shared PrismaClient.
 *
 * Without `connection_limit` in the URL, Prisma sizes each process's pool as `num_cpus * 2 + 1`, and it counts
 * the host's CPUs, not the container's share. On Railway that is 97 connections per process. The bot and the
 * API each open one pool (194 together, twice that while a deploy overlaps old and new containers) against a
 * Postgres whose stock `max_connections` is 100, so a burst can fail with "too many clients" once traffic grows.
 *
 * `withPoolDefaults` fills in a bounded `connection_limit` when the URL doesn't already set one.
 * An explicit, non-empty `connection_limit` in DATABASE_URL always wins, and DATABASE_POOL_SIZE replaces the
 * default. If requests start failing with P2024 (timed out fetching a connection), raise DATABASE_POOL_SIZE.
 * Size the total as processes x pool size x 2 (deploy overlap) and keep it under Postgres `max_connections`.
 */

/** Pool size per process when neither DATABASE_URL nor DATABASE_POOL_SIZE sets one. */
export const DEFAULT_POOL_SIZE = 10;

/**
 * Largest accepted DATABASE_POOL_SIZE. It matches a stock Postgres `max_connections`, so a typo such as an extra
 * zero fails at startup instead of bringing back connection exhaustion. Set `connection_limit` in DATABASE_URL
 * to go higher on purpose.
 */
export const MAX_POOL_SIZE = 100;

/** A `connection_limit` with a value; an empty one (`connection_limit=`) counts as unset. */
const CONNECTION_LIMIT_SET = /[?&]connection_limit=[^&#]/;
/** An empty `connection_limit=`, which gets the computed size filled in. */
const CONNECTION_LIMIT_EMPTY = /([?&])connection_limit=(?=&|#|$)/;
/** Only direct Postgres URLs get a limit; others (e.g. `prisma://` Accelerate) manage their own pool. */
const POSTGRES_SCHEME = /^postgres(?:ql)?:\/\//i;

/**
 * Parses DATABASE_POOL_SIZE: unset or blank means the default; anything but an integer from 1 to MAX_POOL_SIZE
 * throws.
 */
export function parsePoolSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_POOL_SIZE;
  const trimmed = raw.trim();
  const size = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(size) || size < 1 || size > MAX_POOL_SIZE) {
    throw new Error(
      `DATABASE_POOL_SIZE must be a positive integer no greater than ${MAX_POOL_SIZE} (got "${raw}").`,
    );
  }
  return size;
}

/**
 * Returns DATABASE_URL with `connection_limit` added when it has none (or has an empty one). Returns `undefined`
 * for an unset or blank URL so Prisma reports the missing variable exactly as before, and returns non-Postgres
 * URLs unchanged. The URL is only appended to, never re-encoded, so credentials with escaped characters pass
 * through unchanged.
 */
export function withPoolDefaults(
  url: string | undefined,
  poolSizeRaw: string | undefined,
): string | undefined {
  const size = parsePoolSize(poolSizeRaw);
  if (url === undefined || url.trim() === '') return undefined;
  if (!POSTGRES_SCHEME.test(url.trim())) return url;
  if (CONNECTION_LIMIT_SET.test(url)) return url;
  if (CONNECTION_LIMIT_EMPTY.test(url))
    return url.replace(CONNECTION_LIMIT_EMPTY, `$1connection_limit=${size}`);
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : url.slice(hashAt);
  const separator = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?';
  return `${base}${separator}connection_limit=${size}${fragment}`;
}
