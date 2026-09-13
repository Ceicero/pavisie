import type { Client } from 'discord.js';
import type { PluginId } from '@pavisie/types';
import type {
  GuildConfigData,
  GuildConfigPatch,
  GuildConfigStore,
  HostBotStats,
  HostEnableActor,
  HostService,
  Plugin,
  PluginAvailability,
  PluginContext,
  PluginHealth,
  PluginManifest,
  PluginRegistry,
} from '@pavisie/plugins';

export interface CreateHostServiceDeps {
  registry: PluginRegistry;
  configStore: GuildConfigStore;
  /** Computed once at load time from `registry.availability(env, intentsEnabled)` — env/intents don't change at runtime. */
  availability: Map<PluginId, PluginAvailability>;
  /** Populated as each plugin's context is built; read lazily so `host` can be registered before contexts exist. */
  contexts: Map<PluginId, PluginContext>;
  client: Client;
}

function toActor(actor: HostEnableActor): { id: string; source: 'bot' | 'dashboard' | 'system' } {
  return { id: actor.id, source: actor.source };
}

/**
 * Implements `ServiceMap['host']` (packages/plugins/src/sdk/services.ts) — the host-level seam the `admin` plugin
 * needs for cross-plugin, host-level operations that a normal per-plugin `PluginContext` deliberately doesn't
 * expose. Registered under `services.register('host', ...)` before any plugin context is built (see host/loader.ts).
 */
export function createHostService(deps: CreateHostServiceDeps): HostService {
  const { registry, configStore, availability, contexts, client } = deps;

  function getPlugin(pluginId: PluginId): Plugin | undefined {
    return registry.get(pluginId);
  }

  async function runGuildLifecycleHook(
    pluginId: PluginId,
    guildId: string,
    hook: 'onGuildEnable' | 'onGuildDisable',
  ): Promise<void> {
    const plugin = getPlugin(pluginId);
    const ctx = contexts.get(pluginId);
    const fn = plugin?.[hook];
    if (fn && ctx) {
      await fn(ctx, guildId);
    }
  }

  return {
    async enable(guildId, pluginId, actor) {
      await configStore.setEnabled(guildId, pluginId, true, toActor(actor));
      await runGuildLifecycleHook(pluginId, guildId, 'onGuildEnable');
    },

    async disable(guildId, pluginId, actor) {
      await configStore.setEnabled(guildId, pluginId, false, toActor(actor));
      await runGuildLifecycleHook(pluginId, guildId, 'onGuildDisable');
    },

    isPluginEnabled(guildId, pluginId) {
      return configStore.isEnabled(guildId, pluginId);
    },

    listManifests(): PluginManifest[] {
      return registry.listManifests();
    },

    getManifest(pluginId) {
      return registry.get(pluginId)?.manifest;
    },

    getPluginAvailability() {
      return availability;
    },

    async getPluginHealth(pluginId): Promise<PluginHealth | undefined> {
      const plugin = getPlugin(pluginId);
      const ctx = contexts.get(pluginId);
      if (!plugin?.health || !ctx) return undefined;
      return plugin.health(ctx);
    },

    getPluginConfig<T = unknown>(guildId: string, pluginId: PluginId) {
      return configStore.getConfig<T>(guildId, pluginId);
    },

    setPluginConfig<T = unknown>(
      guildId: string,
      pluginId: PluginId,
      patch: Partial<T>,
      actor: HostEnableActor,
    ) {
      return configStore.setConfig<T>(guildId, pluginId, patch, toActor(actor));
    },

    getGuildConfig(guildId: string): Promise<GuildConfigData> {
      return configStore.getGuildConfig(guildId);
    },

    updateGuildConfig(
      guildId: string,
      patch: GuildConfigPatch,
      actor: HostEnableActor,
    ): Promise<GuildConfigData> {
      return configStore.updateGuildConfig(guildId, patch, toActor(actor));
    },

    getBotStats(): HostBotStats {
      const ready = client.isReady();
      return {
        wsPingMs: ready ? Math.max(0, Math.round(client.ws.ping)) : -1,
        uptimeSec: Math.round(process.uptime()),
        guildCount: ready ? client.guilds.cache.size : 0,
        memoryMb: process.memoryUsage().rss / (1024 * 1024),
      };
    },
  };
}
