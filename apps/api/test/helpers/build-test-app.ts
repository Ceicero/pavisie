import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import pino from 'pino';
import { createPrismaStub, type PrismaStubOverrides } from '@pavisie/plugins/sdk/testing';
import { buildApp } from '../../src/app';
import type { ZodFastifyInstance } from '../../src/lib/http';
import type { QueueRegistryLike } from '../../src/lib/queues';
import { SESSION_COOKIE_NAME, createSession, type SessionData } from '../../src/lib/session';

export interface FakeQueueCall {
  queue: string;
  name: string;
  data: unknown;
}

/** In-memory stand-in for `QueueRegistry` that records every `.add()` call instead of touching real BullMQ/Redis. */
export function createFakeQueues(): QueueRegistryLike & { calls: FakeQueueCall[] } {
  const calls: FakeQueueCall[] = [];
  const makeQueue = (queueName: string) => ({
    add: async (name: string, data: unknown) => {
      calls.push({ queue: queueName, name, data });
      return undefined;
    },
  });
  return {
    calls,
    get: (name: string) => makeQueue(name),
    botActions: () => makeQueue('bot-actions'),
    integrationsInbound: () => makeQueue('integrations.inbound'),
    dataRequests: () => makeQueue('data-requests'),
  };
}

export interface TestApp {
  app: ZodFastifyInstance;
  prisma: ReturnType<typeof createPrismaStub>['prisma'];
  prismaCalls: ReturnType<typeof createPrismaStub>['calls'];
  redis: Redis;
  queues: ReturnType<typeof createFakeQueues>;
  /** The OBS-overlay routes' dedicated pub/sub client (`apps/api/src/app.ts`'s `overlaySubscriber`), faked
   * here for the same reason `redis` is: without an injected fake, `buildApp()` opens a real ioredis
   * connection attempt to `REDIS_URL` (unset in tests) on every single test that calls `buildTestApp()`. */
  overlaySubscriber: Redis;
}

/** Builds a fully-wired `buildApp()` instance backed entirely by fakes (recording Prisma stub, `ioredis-mock`, fake queues). */
export async function buildTestApp(prismaOverrides: PrismaStubOverrides = {}): Promise<TestApp> {
  const { prisma, calls: prismaCalls } = createPrismaStub(prismaOverrides);
  const redis = new RedisMock() as unknown as Redis;
  // A second ioredis-mock instance, constructed the same (default-options) way as `redis` above — ioredis-mock
  // shares its in-memory data/pub-sub state across every instance built with the same connection options, so
  // this genuinely receives whatever `redis.publish(...)` sends, exactly like the real second client in app.ts.
  const overlaySubscriber = new RedisMock() as unknown as Redis;
  const queues = createFakeQueues();
  // A silent logger (no pino-pretty transport, which spins up a worker thread) — real logging behavior is
  // exercised by inspection in `app.ts` itself; tests only care about response bodies/status codes.
  const app = await buildApp({ prisma, redis, queues, overlaySubscriber, logger: pino({ enabled: false }) });
  await app.ready();
  return { app, prisma, prismaCalls, redis, queues, overlaySubscriber };
}

export interface LoginAsInput {
  userId: string;
  username?: string;
}

export interface AuthedSession {
  cookieHeader: string;
  session: SessionData;
  sid: string;
}

/** Creates a live session in `redis` and returns a `Cookie` header value, signed exactly the way the real app signs `sid`. */
export async function loginAs(
  app: ZodFastifyInstance,
  redis: Redis,
  input: LoginAsInput,
): Promise<AuthedSession> {
  const { sid, session } = await createSession(redis, {
    userId: input.userId,
    username: input.username ?? 'test-user',
    globalName: null,
    avatarUrl: null,
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    expiresInSec: 3600,
  });
  const signed = app.signCookie(sid);
  return { cookieHeader: `${SESSION_COOKIE_NAME}=${signed}`, session, sid };
}

/** Seeds the 60s Discord-guild-list cache for `userId` so `requireGuildAccess` doesn't need a real Discord token. */
export async function seedUserGuilds(
  redis: Redis,
  userId: string,
  guilds: { id: string; name?: string; icon?: string | null; owner: boolean; permissions: string }[],
): Promise<void> {
  const { redisKey } = await import('@pavisie/core');
  await redis.set(
    redisKey('userguilds', userId),
    JSON.stringify(
      guilds.map((g) => ({
        id: g.id,
        name: g.name ?? 'Test Guild',
        icon: g.icon ?? null,
        owner: g.owner,
        permissions: g.permissions,
      })),
    ),
    'EX',
    60,
  );
}
