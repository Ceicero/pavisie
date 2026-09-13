import Redis, { type RedisOptions } from 'ioredis';
import { env } from './env';
import { ConfigError } from './errors';
import { createLogger } from './logger';

const log = createLogger('redis');

export interface CreateRedisOptions {
  lazyConnect?: boolean;
}

/** Creates a new ioredis client with sane reconnect behavior (required for BullMQ) and error logging. */
export function createRedis(url: string, options: CreateRedisOptions = {}): Redis {
  const redisOptions: RedisOptions = {
    maxRetriesPerRequest: null,
    lazyConnect: options.lazyConnect ?? false,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5000),
  };
  const client = new Redis(url, redisOptions);
  client.on('error', (err: Error) => {
    log.error({ err: err.message }, 'Redis client error');
  });
  return client;
}

let singleton: Redis | undefined;

/** Returns a process-wide singleton Redis client built from `env.REDIS_URL`. Throws ConfigError if unset. */
export function getRedis(): Redis {
  if (!singleton) {
    if (!env.REDIS_URL) {
      throw new ConfigError('REDIS_URL is not set.');
    }
    singleton = createRedis(env.REDIS_URL);
  }
  return singleton;
}

/** Builds a namespaced Redis key: `pavisie:<part>:<part>...`. */
export function redisKey(...parts: string[]): string {
  return ['pavisie', ...parts].join(':');
}
