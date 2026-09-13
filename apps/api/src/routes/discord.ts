import type { ZodFastifyInstance } from '../lib/http';
import type { DiscordChannelOption, DiscordRoleOption } from '@pavisie/types';
import { getCachedGuildChannels, getCachedGuildRoles } from '../lib/discord';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema } from '../lib/schemas';

/**
 * `/guilds/:guildId/discord/*` — read-only Discord resource lists (channels, roles) that back the dashboard's
 * ChannelPicker/RolePicker. Fetched with the bot token (the user's OAuth scopes can't read them) and cached
 * 60s per guild in Redis. Returns 503 `bot_token_missing` when the API has no DISCORD_TOKEN; the dashboard
 * falls back to raw id inputs in that case.
 */
export default async function discordRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/discord/channels',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<DiscordChannelOption[]> => getCachedGuildChannels(app.redis, request.guildId!),
  );

  app.get(
    '/:guildId/discord/roles',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<DiscordRoleOption[]> => getCachedGuildRoles(app.redis, request.guildId!),
  );
}
