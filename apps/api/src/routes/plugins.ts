import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { NotFoundError } from '@pavisie/core';
import { assertKnownConfigKeys } from '@pavisie/plugins';
import { PLUGIN_IDS, type PluginId, type PluginSummary } from '@pavisie/types';
import { requireGuildAccess } from '../lib/guild-access';
import { buildPluginSummaries } from '../lib/plugin-summaries';
import { guildIdParamSchema } from '../lib/schemas';
import { omitSecretFields, omitSecretSchemaProperties } from '../lib/secret-fields';
import { zodToJsonSchema } from '../lib/zod-json-schema';

const pluginIdParamSchema = guildIdParamSchema.extend({
  pluginId: z.enum(PLUGIN_IDS as [PluginId, ...PluginId[]]),
});
const configBodySchema = z.record(z.string(), z.unknown());

/** `/guilds/:guildId/plugins` — plugin marketplace list, enable/disable, and per-plugin config (ARCHITECTURE.md §10). */
export default async function pluginsRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/plugins',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<PluginSummary[]> => {
      const guildId = request.guildId!;
      return buildPluginSummaries(app, guildId);
    },
  );

  app.post(
    '/:guildId/plugins/:pluginId/enable',
    { schema: { params: pluginIdParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const { guildId, pluginId } = request.params as { guildId: string; pluginId: PluginId };
      const session = request.session!;
      await app.configStore.setEnabled(guildId, pluginId, true, { id: session.userId, source: 'dashboard' });
      return { ok: true };
    },
  );

  app.post(
    '/:guildId/plugins/:pluginId/disable',
    { schema: { params: pluginIdParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const { guildId, pluginId } = request.params as { guildId: string; pluginId: PluginId };
      const session = request.session!;
      await app.configStore.setEnabled(guildId, pluginId, false, { id: session.userId, source: 'dashboard' });
      return { ok: true };
    },
  );

  // Both handlers below respond with `{ config, schema }` (config value + this plugin's JSON-Schema-shaped
  // configSchema), matching what apps/dashboard's `usePluginConfig`/`useUpdatePluginConfig` expect
  // (ARCHITECTURE.md §11: "config drawer (auto-form from JSON schema of configSchema)") — the drawer needs
  // both on every load/save round trip, not just via the separate `/config-schema` endpoint below.
  //
  // Secret-bearing fields (e.g. `ai`'s `apiKeyEnc`) are stripped from both the config value and the schema
  // here — API responses never return encrypted/decrypted secrets, and this generic path must not bypass that
  // just because a plugin doesn't have a dedicated settings route. Plugins that need to manage a secret get a
  // dedicated route (e.g. `/ai/settings`'s `hasKey`/`apiKey`) instead.
  app.get(
    '/:guildId/plugins/:pluginId/config',
    { schema: { params: pluginIdParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const { guildId, pluginId } = request.params as { guildId: string; pluginId: PluginId };
      const manifest = app.registry.get(pluginId)?.manifest;
      if (!manifest) throw new NotFoundError(`Unknown plugin "${pluginId}".`);
      const config = await app.configStore.getConfig(guildId, pluginId);
      return {
        config: omitSecretFields(config),
        schema: omitSecretSchemaProperties(zodToJsonSchema(manifest.configSchema)),
      };
    },
  );

  app.put(
    '/:guildId/plugins/:pluginId/config',
    { schema: { params: pluginIdParamSchema, body: configBodySchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const { guildId, pluginId } = request.params as { guildId: string; pluginId: PluginId };
      const session = request.session!;
      const manifest = app.registry.get(pluginId)?.manifest;
      if (!manifest) throw new NotFoundError(`Unknown plugin "${pluginId}".`);
      // Reject any top-level key this plugin's configSchema doesn't recognize *before* redacting secrets, and
      // check it against the *full* (unredacted) configSchema — so a legitimate secret field name (e.g. ai's
      // apiKeyEnc) is never mistaken for an unknown/typo'd key. This is what turns a wrongly-shaped write (e.g.
      // `{ config: {...} }` instead of the bare config object) into a loud 400 instead of a silent no-op 200 with
      // the junk key persisted into the stored raw JSON forever (zod objects strip unknown keys by default).
      assertKnownConfigKeys(pluginId, manifest.configSchema, request.body);
      // Never let this generic path write a secret field — silently drop it rather than let the dashboard
      // corrupt (or spoof) a plugin's encrypted key/token by round-tripping the auto-form.
      const body = omitSecretFields(request.body);
      // configStore.setConfig validates the patch against the plugin's own configSchema, throwing a
      // ZodError (-> 400 validation_error via toPublicError) on a bad shape.
      const config = await app.configStore.setConfig(guildId, pluginId, body, {
        id: session.userId,
        source: 'dashboard',
      });
      return {
        config: omitSecretFields(config),
        schema: omitSecretSchemaProperties(zodToJsonSchema(manifest.configSchema)),
      };
    },
  );

  app.get(
    '/:guildId/plugins/:pluginId/config-schema',
    { schema: { params: pluginIdParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const { pluginId } = request.params as { guildId: string; pluginId: PluginId };
      const manifest = app.registry.get(pluginId)?.manifest;
      if (!manifest) throw new NotFoundError(`Unknown plugin "${pluginId}".`);
      return omitSecretSchemaProperties(zodToJsonSchema(manifest.configSchema));
    },
  );
}
