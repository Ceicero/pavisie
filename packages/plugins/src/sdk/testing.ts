import type { Queue } from 'bullmq';
import type { Client } from 'discord.js';
// ioredis-mock has no first-party types; a local ambient declaration (src/types/ioredis-mock.d.ts) types it
// as `Redis`-compatible.
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import pino from 'pino';
import { MemoryRateLimiter, PlatformEvents, env as coreEnv, t as coreT } from '@pavisie/core';
import { ServiceRegistry } from './services';
import type { PluginContext } from './types';

export interface RecordedPrismaCall {
  model: string;
  method: string;
  args: unknown[];
}

export type PrismaStubOverrides = Record<string, Record<string, (...args: unknown[]) => unknown>>;

/** Sensible default resolutions per Prisma delegate method name, used when a stub call has no override. */
function defaultResolutionFor(method: string): unknown {
  if (method === 'findMany') return Promise.resolve([]);
  if (method.startsWith('find')) return Promise.resolve(null);
  if (method === 'count') return Promise.resolve(0);
  if (method === 'aggregate') return Promise.resolve({ _max: {}, _min: {}, _sum: {}, _avg: {}, _count: {} });
  if (method === 'deleteMany' || method === 'updateMany') return Promise.resolve({ count: 0 });
  if (method === '$transaction') return Promise.resolve([]);
  return Promise.resolve(undefined);
}

/**
 * Builds a minimal in-memory Prisma stub via `Proxy`: `prisma.<model>.<method>(...)` records the call and
 * resolves with `overrides[model][method](...)` if provided, else a reasonable default for that method name.
 * Not a real Prisma client — only good for unit-testing plugin logic that calls a handful of delegate methods.
 */
export function createPrismaStub(overrides: PrismaStubOverrides = {}): {
  prisma: PluginContext['prisma'];
  calls: RecordedPrismaCall[];
} {
  const calls: RecordedPrismaCall[] = [];
  const modelProxies = new Map<string, unknown>();

  const prisma = new Proxy(
    {},
    {
      get(_target, modelProp: string | symbol) {
        if (typeof modelProp !== 'string') return undefined;
        const cached = modelProxies.get(modelProp);
        if (cached) return cached;

        const modelOverrides = overrides[modelProp] ?? {};
        const modelProxy = new Proxy(
          {},
          {
            get(_t, methodProp: string | symbol) {
              if (typeof methodProp !== 'string') return undefined;
              return (...args: unknown[]) => {
                calls.push({ model: modelProp, method: methodProp, args });
                const override = modelOverrides[methodProp];
                return override ? override(...args) : defaultResolutionFor(methodProp);
              };
            },
          },
        );
        modelProxies.set(modelProp, modelProxy);
        return modelProxy;
      },
    },
  ) as PluginContext['prisma'];

  return { prisma, calls };
}

export interface TestContextOverrides {
  botOwnerIds?: string[];
  /** Value `ctx.getConfig` resolves with for any guildId, unless `configByGuild` has a more specific entry. */
  config?: unknown;
  configByGuild?: Record<string, unknown>;
  /** Value `ctx.isEnabled` resolves with. Defaults to `true`. */
  enabled?: boolean;
  prismaOverrides?: PrismaStubOverrides;
  intentsEnabled?: Partial<PluginContext['intentsEnabled']>;
  /** Escape hatch: shallow-overrides any `PluginContext` field after everything else is built (applied last). */
  overrides?: Partial<PluginContext>;
}

export interface TestContext {
  ctx: PluginContext;
  prismaCalls: RecordedPrismaCall[];
  redis: Redis;
  events: PlatformEvents;
  services: ServiceRegistry;
}

/**
 * Builds a `PluginContext` backed entirely by in-memory fakes (`ioredis-mock`, a recording Prisma `Proxy`
 * stub, a silent pino logger, `MemoryRateLimiter`, a fresh `ServiceRegistry`/`PlatformEvents`) for plugin unit
 * tests that need a context but shouldn't touch a real database, Redis, or Discord gateway connection.
 */
export function createTestContext(overrides: TestContextOverrides = {}): TestContext {
  const { prisma, calls } = createPrismaStub(overrides.prismaOverrides);
  const redis = new RedisMock() as unknown as Redis;
  const logger = pino({ enabled: false });
  const events = new PlatformEvents();
  const services = new ServiceRegistry();
  const rateLimiter = new MemoryRateLimiter();

  const configByGuild = overrides.configByGuild ?? {};
  const fallbackConfig = overrides.config ?? {};
  const enabled = overrides.enabled ?? true;

  const baseCtx: PluginContext = {
    // Tests that need real gateway behavior should build their own discord.js fixtures and override `client`.
    client: {} as unknown as Client<true>,
    prisma,
    redis,
    logger,
    events,
    rateLimiter,
    queue: (_jobName: string) => ({ add: async () => undefined }) as unknown as Queue,
    getConfig: async <T>(guildId: string) =>
      (guildId in configByGuild ? configByGuild[guildId] : fallbackConfig) as T,
    setConfig: async <T>(guildId: string, patch: Partial<T>) =>
      ({
        ...((guildId in configByGuild ? configByGuild[guildId] : fallbackConfig) as object),
        ...patch,
      }) as T,
    isEnabled: async () => enabled,
    services,
    audit: async () => undefined,
    t: coreT,
    env: coreEnv,
    botOwnerIds: overrides.botOwnerIds ?? [],
    intentsEnabled: {
      messageContent: false,
      guildMembers: true,
      guildPresences: false,
      ...overrides.intentsEnabled,
    },
  };

  const ctx: PluginContext = { ...baseCtx, ...overrides.overrides };

  return { ctx, prismaCalls: calls, redis, events, services };
}
