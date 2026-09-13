import { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import type Redis from 'ioredis';
import type { Client } from 'discord.js';
import { createLogger, RateLimiter, env as coreEnv, type PlatformEvents } from '@pavisie/core';
import { writeAudit, type PrismaClient } from '@pavisie/database';
import type { PluginId } from '@pavisie/types';
import {
  GuildConfigStore,
  ServiceRegistry,
  registerPluginLocales,
  type Plugin,
  type PluginContext,
} from '@pavisie/plugins';

export interface BuildContextDeps {
  client: Client<true>;
  prisma: PrismaClient;
  redis: Redis;
  events: PlatformEvents;
  configStore: GuildConfigStore;
  services: ServiceRegistry;
  /** Shared connection *options* (ARCHITECTURE.md §9's "shared IORedis connection options object for BullMQ") — every
   * plugin's `queue()` factory builds its BullMQ `Queue`s from this same options object rather than a live client,
   * since BullMQ manages its own internal Redis connections per Queue/Worker. */
  bullConnectionOptions: RedisOptions;
  /** Shared across every plugin context so `Queue` instances for `<pluginId>.<jobName>` are created at most once. */
  queueCache: Map<string, Queue>;
  botOwnerIds: string[];
  intentsEnabled: PluginContext['intentsEnabled'];
}

/** Returns (creating and caching on first use) the BullMQ `Queue` for `<pluginId>.<jobName>`. */
function getOrCreateQueue(deps: BuildContextDeps, pluginId: PluginId, jobName: string): Queue {
  const key = `${pluginId}.${jobName}`;
  const existing = deps.queueCache.get(key);
  if (existing) return existing;

  const queue = new Queue(key, { connection: deps.bullConnectionOptions });
  deps.queueCache.set(key, queue);
  return queue;
}

/**
 * Builds the `PluginContext` for one plugin (ARCHITECTURE.md §9/§7.2): a child logger, a queue factory scoped to
 * this plugin's id, config-store bindings bound to this plugin's id, the shared cross-plugin `ServiceRegistry`,
 * an audit writer, and a `t` bound to this plugin's locale namespace (falling back to core strings).
 */
export function buildPluginContext(plugin: Plugin, deps: BuildContextDeps): PluginContext {
  const pluginId = plugin.manifest.id;
  // No-op merge when the plugin's own `index.ts` already called `registerPluginLocales(pluginId, {...})` at
  // module load — this just recovers the same bound `t` function without re-registering anything (see
  // packages/plugins/src/sdk/locales.ts; this is the documented contract for how the host obtains per-plugin `t`).
  const boundT = registerPluginLocales(pluginId, {});
  const logger = createLogger(`plugin:${pluginId}`);
  const rateLimiter = new RateLimiter(deps.redis);

  const ctx: PluginContext = {
    client: deps.client,
    prisma: deps.prisma,
    redis: deps.redis,
    logger,
    events: deps.events,
    rateLimiter,
    queue: (jobName: string) => getOrCreateQueue(deps, pluginId, jobName),
    getConfig: <T>(guildId: string) => deps.configStore.getConfig<T>(guildId, pluginId),
    setConfig: <T>(
      guildId: string,
      patch: Partial<T>,
      actor: { id: string; source: 'bot' | 'dashboard' | 'system' },
    ) => deps.configStore.setConfig<T>(guildId, pluginId, patch, actor),
    isEnabled: (guildId: string, targetPluginId?: PluginId) =>
      deps.configStore.isEnabled(guildId, targetPluginId ?? pluginId),
    services: deps.services,
    audit: (entry) => writeAudit(deps.prisma, entry).then(() => undefined),
    t: boundT,
    env: coreEnv,
    botOwnerIds: deps.botOwnerIds,
    intentsEnabled: deps.intentsEnabled,
  };

  return ctx;
}
