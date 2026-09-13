import { GatewayIntentBits } from 'discord.js';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord-api-types/v10';
import type { PluginId } from '@pavisie/types';
import type { Plugin, PluginManifest, PrivilegedIntent } from './types';
import { withHelpHint } from './help-hint';

export interface PrivilegedIntentsEnabled {
  messageContent: boolean;
  guildMembers: boolean;
  guildPresences: boolean;
}

export interface PluginAvailability {
  available: boolean;
  /** True when the plugin is available but running with reduced functionality (e.g. a privileged intent is off). */
  degraded?: boolean;
  reason?: string;
}

const PRIVILEGED_INTENT_TO_ENABLED_KEY: Record<PrivilegedIntent, keyof PrivilegedIntentsEnabled> = {
  MessageContent: 'messageContent',
  GuildMembers: 'guildMembers',
  GuildPresences: 'guildPresences',
};

const PRIVILEGED_INTENT_TO_BIT: Record<PrivilegedIntent, GatewayIntentBits> = {
  MessageContent: GatewayIntentBits.MessageContent,
  GuildMembers: GatewayIntentBits.GuildMembers,
  GuildPresences: GatewayIntentBits.GuildPresences,
};

/** Loose env-like shape: any object whose values can be checked for "present and non-empty" by key. */
export type EnvLike = Record<string, unknown>;

function isEnvValueSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Holds every loaded plugin, validating cross-plugin invariants at construction time (ARCHITECTURE.md §7.3):
 * unique plugin ids, unique top-level command names across all plugins, unique component action names within
 * each plugin, and that every manifest's `defaultConfig` actually parses against its own `configSchema`.
 * Throws on the first violation found.
 */
export class PluginRegistry {
  private readonly pluginsById = new Map<PluginId, Plugin>();
  private readonly orderedPlugins: Plugin[];

  constructor(plugins: Plugin[]) {
    this.orderedPlugins = plugins;
    this.validate(plugins);
    for (const plugin of plugins) {
      this.pluginsById.set(plugin.manifest.id, plugin);
    }
  }

  private validate(plugins: Plugin[]): void {
    const seenIds = new Set<PluginId>();
    const seenCommandNames = new Map<string, PluginId>();

    for (const plugin of plugins) {
      const { id } = plugin.manifest;

      if (seenIds.has(id)) {
        throw new Error(`PluginRegistry: duplicate plugin id "${id}".`);
      }
      seenIds.add(id);

      const defaultConfigCheck = plugin.manifest.configSchema.safeParse(plugin.manifest.defaultConfig);
      if (!defaultConfigCheck.success) {
        throw new Error(
          `PluginRegistry: plugin "${id}" has a defaultConfig that fails its own configSchema: ${defaultConfigCheck.error.message}`,
        );
      }

      for (const command of plugin.commands) {
        const name = command.data.name;
        if (!name) {
          throw new Error(`PluginRegistry: plugin "${id}" has a command with no name set.`);
        }
        const owner = seenCommandNames.get(name);
        if (owner) {
          throw new Error(
            `PluginRegistry: duplicate command name "${name}" registered by both "${owner}" and "${id}".`,
          );
        }
        seenCommandNames.set(name, id);
      }

      const seenActions = new Set<string>();
      for (const component of plugin.components ?? []) {
        if (seenActions.has(component.action)) {
          throw new Error(
            `PluginRegistry: plugin "${id}" registers duplicate component action "${component.action}".`,
          );
        }
        seenActions.add(component.action);
      }
    }
  }

  /** Returns the loaded plugin for `id`, or `undefined` if it isn't loaded. */
  get(id: PluginId): Plugin | undefined {
    return this.pluginsById.get(id);
  }

  /** All loaded plugins, in the order they were registered. */
  list(): Plugin[] {
    return this.orderedPlugins;
  }

  /** All loaded manifests, in registration order. */
  listManifests(): PluginManifest[] {
    return this.orderedPlugins.map((p) => p.manifest);
  }

  /** Serializes every command from every plugin into the shape Discord's bulk command REST endpoint expects. */
  commandsJson(): RESTPostAPIApplicationCommandsJSONBody[] {
    return this.orderedPlugins.flatMap((plugin) =>
      plugin.commands.map((command) => {
        const json = command.data.toJSON() as RESTPostAPIApplicationCommandsJSONBody;
        // Apply help hint to top-level CHAT_INPUT commands only (type undefined or 1)
        if ((json.type === undefined || json.type === 1) && 'description' in json) {
          return { ...json, description: withHelpHint(json.description as string) };
        }
        return json;
      }),
    );
  }

  /**
   * Unions every plugin's declared non-privileged `manifest.intents`, plus any privileged intent that at least
   * one loaded plugin declares in `manifest.privilegedIntents` *and* the host has enabled via `enabled`.
   */
  requiredIntents(enabled: PrivilegedIntentsEnabled): GatewayIntentBits[] {
    const intents = new Set<GatewayIntentBits>();
    for (const plugin of this.orderedPlugins) {
      for (const intent of plugin.manifest.intents) {
        intents.add(intent);
      }
    }

    for (const [privileged, enabledKey] of Object.entries(PRIVILEGED_INTENT_TO_ENABLED_KEY) as [
      PrivilegedIntent,
      keyof PrivilegedIntentsEnabled,
    ][]) {
      if (!enabled[enabledKey]) continue;
      const anyPluginNeedsIt = this.orderedPlugins.some((plugin) =>
        plugin.manifest.privilegedIntents?.includes(privileged),
      );
      if (anyPluginNeedsIt) {
        intents.add(PRIVILEGED_INTENT_TO_BIT[privileged]);
      }
    }

    return [...intents];
  }

  /**
   * Computes each plugin's availability: unavailable (with a reason listing missing vars) if any `requiredEnv`
   * var is unset/empty in `env`; else degraded (available, but with a reason) if it declares a `privilegedIntents`
   * entry that isn't enabled in `intentsEnabled`; else fully available.
   */
  availability(env: EnvLike, intentsEnabled: PrivilegedIntentsEnabled): Map<PluginId, PluginAvailability> {
    const result = new Map<PluginId, PluginAvailability>();

    for (const plugin of this.orderedPlugins) {
      const { manifest } = plugin;

      const missingEnv = manifest.requiredEnv.filter((key) => !isEnvValueSet(env[key]));
      if (missingEnv.length > 0) {
        result.set(manifest.id, {
          available: false,
          reason: `Missing required environment variable(s): ${missingEnv.join(', ')}.`,
        });
        continue;
      }

      const missingPrivileged = (manifest.privilegedIntents ?? []).filter(
        (privileged) => !intentsEnabled[PRIVILEGED_INTENT_TO_ENABLED_KEY[privileged]],
      );
      if (missingPrivileged.length > 0) {
        result.set(manifest.id, {
          available: true,
          degraded: true,
          reason: `Privileged intent(s) not enabled, some features are limited: ${missingPrivileged.join(', ')}.`,
        });
        continue;
      }

      result.set(manifest.id, { available: true });
    }

    return result;
  }
}
