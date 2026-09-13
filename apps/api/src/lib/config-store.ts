import type Redis from 'ioredis';
import type { PlatformEvents } from '@pavisie/core';
import type { PrismaClient } from '@pavisie/database';
import { allManifests } from '@pavisie/plugins/manifests';
import { GuildConfigStore, PluginRegistry, type Plugin } from '@pavisie/plugins/sdk';

/**
 * Builds the `PluginRegistry` from manifests only (not `allPlugins`) — the API only ever needs
 * `manifest`-level data (config schema, defaults, availability, permissions) for config/enable
 * purposes, never a plugin's commands/events/jobs, so this avoids pulling every plugin's discord.js
 * command-building code into the API process (ARCHITECTURE.md §10 note on this exact tradeoff).
 */
function buildManifestOnlyRegistry(): PluginRegistry {
  const plugins: Plugin[] = allManifests.map((manifest) => ({ manifest, commands: [] }));
  return new PluginRegistry(plugins);
}

/** Builds a `GuildConfigStore` (and the `PluginRegistry` it needs) bound to `prisma`/`redis`, optionally emitting platform events. */
export function createGuildConfigStore(
  prisma: PrismaClient,
  redis: Redis,
  events?: PlatformEvents,
): { store: GuildConfigStore; registry: PluginRegistry } {
  const registry = buildManifestOnlyRegistry();
  const store = new GuildConfigStore(prisma, redis, registry, events);
  return { store, registry };
}
