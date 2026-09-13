import type { Client } from 'discord.js';
import type { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { Cooldowns, RateLimiter, createPlatformEvents, type RateLimiterLike } from '@pavisie/core';
import type { PrismaClient } from '@pavisie/database';
import type { PluginId } from '@pavisie/types';
import {
  GuildConfigStore,
  PluginRegistry,
  ServiceRegistry,
  type ComponentHandler,
  type EnvLike,
  type Plugin,
  type PluginAvailability,
  type PluginCommand,
  type PluginContext,
  type PrivilegedIntentsEnabled,
} from '@pavisie/plugins';
import { buildPluginContext } from './context';
import { createHostService } from './host-service';

export interface LoadPluginsDeps {
  plugins: Plugin[];
  client: Client<true>;
  prisma: PrismaClient;
  redis: Redis;
  env: EnvLike;
  botOwnerIds: string[];
  intentsEnabled: PrivilegedIntentsEnabled;
  bullConnectionOptions: RedisOptions;
  logger: Logger;
}

export interface CommandEntry {
  plugin: Plugin;
  command: PluginCommand;
}

export interface ComponentEntry {
  plugin: Plugin;
  handler: ComponentHandler;
}

export interface LoadedHost {
  registry: PluginRegistry;
  configStore: GuildConfigStore;
  services: ServiceRegistry;
  events: ReturnType<typeof createPlatformEvents>;
  contexts: Map<PluginId, PluginContext>;
  commands: Map<string, CommandEntry>;
  /** Keyed `<pluginId>:<action>`. */
  components: Map<string, ComponentEntry>;
  availability: Map<PluginId, PluginAvailability>;
  botOwnerIds: string[];
  cooldowns: Cooldowns;
  globalRateLimiter: RateLimiterLike;
  /** Every `Queue` created by any plugin's `ctx.queue(...)`, so repeatable schedulers can be upserted and queues closed on shutdown. */
  queueCache: Map<string, Queue>;
}

/** Best-effort extraction of a guild id from a heterogeneous `ClientEvents[K]` args tuple, for the platform error event. */
function firstGuildIdArg(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (
      arg &&
      typeof arg === 'object' &&
      'guildId' in arg &&
      typeof (arg as { guildId: unknown }).guildId === 'string'
    ) {
      return (arg as { guildId: string }).guildId;
    }
    if (arg && typeof arg === 'object' && 'guild' in arg) {
      const guild = (arg as { guild?: { id?: unknown } }).guild;
      if (guild && typeof guild.id === 'string') return guild.id;
    }
  }
  return undefined;
}

/**
 * Loads every plugin (ARCHITECTURE.md §9): registers the `host` cross-plugin service before building any plugin
 * context, builds one `PluginContext` per plugin, runs pending data migrations, calls `onLoad`, registers Discord
 * gateway event listeners (gated on guild availability/enablement, with per-handler error isolation), collects
 * component handlers into a `<pluginId>:<action>` map, collects slash/context-menu commands into a name map, and
 * upserts every declared repeatable job's scheduler. Does not itself start BullMQ `Worker`s that *process* jobs —
 * that is `workers.ts`'s job, so job processing can be split into its own process later without depending on this
 * module's Discord-event wiring.
 */
export async function loadPlugins(deps: LoadPluginsDeps): Promise<LoadedHost> {
  const { plugins, client, prisma, redis, env, botOwnerIds, intentsEnabled, bullConnectionOptions, logger } =
    deps;

  const registry = new PluginRegistry(plugins);
  const events = createPlatformEvents(logger);
  const configStore = new GuildConfigStore(prisma, redis, registry, events);
  const services = new ServiceRegistry();
  const availability = registry.availability(env, intentsEnabled);
  const contexts = new Map<PluginId, PluginContext>();
  const queueCache = new Map<string, Queue>();

  // Contract: the `host` service must be registered before any plugin context is built (and long before any
  // interaction is routed), because `admin`'s commands call `ctx.services.require('host')`. `contexts` is passed
  // by reference and populated below — `getPluginHealth`/`enable`/`disable` read it lazily.
  services.register('host', createHostService({ registry, configStore, availability, contexts, client }));

  const commands = new Map<string, CommandEntry>();
  const components = new Map<string, ComponentEntry>();

  for (const plugin of plugins) {
    const pluginId = plugin.manifest.id;

    const ctx = buildPluginContext(plugin, {
      client,
      prisma,
      redis,
      events,
      configStore,
      services,
      bullConnectionOptions,
      queueCache,
      botOwnerIds,
      intentsEnabled,
    });
    contexts.set(pluginId, ctx);

    for (const migration of plugin.migrations ?? []) {
      const already = await prisma.pluginMigration.findUnique({
        where: { pluginId_migrationId: { pluginId, migrationId: migration.id } },
      });
      if (already) continue;
      try {
        await migration.run(ctx);
        await prisma.pluginMigration.create({ data: { pluginId, migrationId: migration.id } });
        logger.info({ plugin: pluginId, migration: migration.id }, 'plugin migration applied');
      } catch (err) {
        logger.error({ plugin: pluginId, migration: migration.id, err }, 'plugin migration failed');
        throw err;
      }
    }

    if (plugin.onLoad) {
      try {
        await plugin.onLoad(ctx);
      } catch (err) {
        logger.error({ plugin: pluginId, err }, 'plugin onLoad threw; plugin may be partially initialized');
        throw err;
      }
    }

    for (const command of plugin.commands) {
      commands.set(command.data.name, { plugin, command });
    }

    for (const component of plugin.components ?? []) {
      components.set(`${pluginId}:${component.action}`, { plugin, handler: component });
    }

    for (const handler of plugin.events ?? []) {
      // Bridging a heterogeneous PluginEventHandler<K> against client.on's per-event overloads inside a loop over
      // many different event names; `Plugin['events']` itself already erases `K` to `any` for the same reason
      // (see sdk/types.ts's own justified disable there).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const listener = (...args: any[]) => {
        void (async () => {
          const guildId: string | null | undefined = handler.guildIdOf ? handler.guildIdOf(...args) : null;
          if (guildId) {
            const pluginAvailability = availability.get(pluginId);
            if (!pluginAvailability?.available) return;
            if (!plugin.manifest.alwaysEnabled) {
              const enabled = await configStore.isEnabled(guildId, pluginId);
              if (!enabled) return;
            }
          }
          try {
            await handler.handler(ctx, ...args);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(
              { plugin: pluginId, event: handler.event, err: message },
              'plugin event handler threw',
            );
            events.emit('plugin.error', {
              pluginId,
              guildId: guildId ?? firstGuildIdArg(args),
              error: message,
            });
          }
        })();
      };

      if (handler.once) {
        client.once(handler.event, listener);
      } else {
        client.on(handler.event, listener);
      }
    }

    for (const job of plugin.jobs ?? []) {
      if (!job.repeat) continue;
      const queue = ctx.queue(job.name);
      try {
        await queue.upsertJobScheduler(job.name, { pattern: job.repeat.pattern }, { name: job.name });
      } catch (err) {
        logger.error({ plugin: pluginId, job: job.name, err }, 'failed to upsert repeatable job scheduler');
      }
    }
  }

  return {
    registry,
    configStore,
    services,
    events,
    contexts,
    commands,
    components,
    availability,
    botOwnerIds,
    cooldowns: new Cooldowns(redis),
    globalRateLimiter: new RateLimiter(redis),
    queueCache,
  };
}
