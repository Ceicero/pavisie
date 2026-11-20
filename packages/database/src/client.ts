import { PrismaClient } from '@prisma/client';
import { loadEnv } from '@pavisie/core/env';
import { withPoolDefaults } from './pool';

// Cache the PrismaClient instance on `globalThis` outside production so that
// hot-reloading dev processes (tsx watch, Next.js dev) reuse one connection
// pool instead of opening a new one on every reload.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Builds the Prisma log config from LOG_LEVEL; 'query' logging only fires when LOG_LEVEL=trace. */
function buildLogConfig(): ('query' | 'info' | 'warn' | 'error')[] {
  const level = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  const levels: ('query' | 'info' | 'warn' | 'error')[] = ['warn', 'error'];
  if (level === 'trace') levels.unshift('query', 'info');
  else if (level === 'debug' || level === 'info') levels.unshift('info');
  return levels;
}

/** Builds the client, bounding its pool (see pool.ts); with no DATABASE_URL, Prisma's own missing-env error stands. */
function createClient(): PrismaClient {
  // Apps import this module before their own loadEnv() call, so load the repo .env here first (idempotent);
  // otherwise a DATABASE_URL that only lives in .env would be read by Prisma itself, with no pool bound.
  loadEnv();
  const datasourceUrl = withPoolDefaults(process.env.DATABASE_URL, process.env.DATABASE_POOL_SIZE);
  return new PrismaClient({
    log: buildLogConfig(),
    ...(datasourceUrl === undefined ? {} : { datasourceUrl }),
  });
}

/** Shared PrismaClient singleton for the whole monorepo; reused across hot reloads in non-production. */
export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient } from '@prisma/client';
