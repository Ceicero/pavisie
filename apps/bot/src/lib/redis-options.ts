import type { RedisOptions } from 'ioredis';

/**
 * Parses a `redis://` / `rediss://` URL into a plain `ioredis` options object suitable for BullMQ's `connection`
 * option. BullMQ constructs its own internal `ioredis` connections per `Queue`/`Worker` from this shared options
 * object (rather than reusing one live connection across many blocking Worker clients), and always requires
 * `maxRetriesPerRequest: null` — this is not exported by `@pavisie/core`'s `createRedis`, which returns a live
 * client rather than an options object, so it lives here as a small bot-local helper (ARCHITECTURE.md's
 * "implement a local helper under apps/bot/src/lib/" escape hatch).
 */
export function bullConnectionOptionsFromUrl(redisUrl: string): RedisOptions {
  const parsed = new URL(redisUrl);

  const options: RedisOptions = {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number(parsed.port) : 6379,
    maxRetriesPerRequest: null,
  };

  if (parsed.username) options.username = decodeURIComponent(parsed.username);
  if (parsed.password) options.password = decodeURIComponent(parsed.password);

  const dbPath = parsed.pathname.replace(/^\//, '');
  if (dbPath && !Number.isNaN(Number(dbPath))) {
    options.db = Number(dbPath);
  }

  if (parsed.protocol === 'rediss:') {
    options.tls = {};
  }

  return options;
}
