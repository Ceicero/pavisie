import { env as coreEnv } from '@pavisie/core';
import type { PluginSummary } from '@pavisie/types';
import type { ZodFastifyInstance } from './http';

/** Which privileged Discord gateway intents this host has enabled, keyed the way `PluginRegistry.availability` expects. */
export function intentsEnabled() {
  return {
    messageContent: coreEnv.ENABLE_MESSAGE_CONTENT_INTENT,
    guildMembers: coreEnv.ENABLE_GUILD_MEMBERS_INTENT,
    guildPresences: coreEnv.ENABLE_GUILD_PRESENCES_INTENT,
  };
}

/**
 * Builds the dashboard-facing `PluginSummary[]` for a guild: every loaded plugin's manifest metadata, its
 * enablement (`PluginState`, falling back to the manifest default), and its availability (missing required env
 * vars / disabled privileged intents) via `PluginRegistry.availability`. Shared by `routes/plugins.ts`
 * (`GET /:guildId/plugins`) and `routes/guilds.ts` (`GET /:guildId` overview) so both surfaces agree
 * (ARCHITECTURE.md §10).
 */
export async function buildPluginSummaries(app: ZodFastifyInstance, guildId: string): Promise<PluginSummary[]> {
  const manifests = app.registry.listManifests();
  const availability = app.registry.availability(coreEnv as unknown as Record<string, unknown>, intentsEnabled());
  const stateRows = await app.prisma.pluginState.findMany({ where: { guildId } });
  const enabledMap = new Map(stateRows.map((row) => [row.pluginId, row.enabled]));

  return manifests.map((manifest): PluginSummary => {
    const avail = availability.get(manifest.id) ?? { available: false };
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      category: manifest.category,
      version: manifest.version,
      enabled: manifest.alwaysEnabled ? true : (enabledMap.get(manifest.id) ?? manifest.defaultEnabled),
      defaultEnabled: manifest.defaultEnabled,
      alwaysEnabled: Boolean(manifest.alwaysEnabled),
      available: avail.available,
      availabilityReason: avail.reason,
      dashboardPath: manifest.dashboard?.path,
      privacyNotes: manifest.privacyNotes ?? [],
      permissions: manifest.permissions.map((p) => ({
        permission: String(p.permission),
        feature: p.feature,
        optional: p.optional,
        fallback: p.fallback,
      })),
      privilegedIntents: manifest.privilegedIntents ?? [],
    };
  });
}
