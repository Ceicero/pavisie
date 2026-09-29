import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { NotFoundError } from '@pavisie/core';
import type { TwitchChatGuildLinksDto } from '@pavisie/types/integrations';
import { unlinkChannelFromGuild } from '../lib/creator/discord-link';
import { requireGuildAccess } from '../lib/guild-access';
import { CONNECTION_STATUS_MAP } from '../lib/dto';
import { guildIdParamSchema } from '../lib/schemas';

const channelParamSchema = guildIdParamSchema.extend({ channelId: z.string().min(1) });

/**
 * `/guilds/:guildId/integrations/twitch-chat` — the Discord dashboard's READ-ONLY view of a Twitch channel linked to
 * this server, plus the one write a server admin keeps: unlinking their server (ARCHITECTURE.md §19e, phase 4).
 *
 * Since creator-dashboard phase 4 everything Twitch-chat related (chat bot commands/timers, channel points, the
 * currency, the Discord <-> Twitch bridge, connecting a server) is managed ONLY by the streamer, on the creator
 * dashboard (`routes/creator-twitch*.ts`). The Discord side is notifications/alerts only. What is left here:
 *
 * - `GET` — which Twitch channel(s) are linked to this server: login and link/bot status, nothing else. Never a token,
 *   a broadcaster user id, a Discord channel id or a webhook credential. Discord session + manage access to the guild.
 * - `DELETE .../channels/:channelId` — a server admin unlinks THEIR server from the channel (their server, their
 *   right). It is exactly the creator-side unlink (`unlinkChannelFromGuild`): the bridge webhook is removed, the bridge
 *   and any Discord-post rewards are cleared, and the channel itself — the streamer's commands, timers, currency,
 *   other rewards, overlay — is left with the streamer, now without a Discord server. It never deletes the channel.
 *   Discord session + manage access, the session's CSRF token (`lib/csrf.ts`, applies to every mutating route), and a
 *   `integration.twitch_chat.discord.unlink` audit entry in this server's log with the Discord user as the actor.
 */
export default async function twitchChatRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/integrations/twitch-chat',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<TwitchChatGuildLinksDto> => {
      const guildId = request.guildId!;
      const channels = await app.prisma.twitchChatChannel.findMany({ where: { guildId }, orderBy: { createdAt: 'desc' } });
      return {
        channels: channels.map((row) => ({
          id: row.id,
          broadcasterLogin: row.broadcasterLogin,
          linkedByStreamer: Boolean(row.discordLinkedBy),
          linkedAt: row.discordLinkedAt ? row.discordLinkedAt.toISOString() : null,
          enabled: row.enabled,
          status: CONNECTION_STATUS_MAP[row.status],
        })),
      };
    },
  );

  app.delete(
    '/:guildId/integrations/twitch-chat/channels/:channelId',
    { schema: { params: channelParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { channelId } = request.params as { channelId: string };

      // Scoped to THIS guild: a channel id from another server (or a guildless channel) is a 404, never touched.
      const existing = await app.prisma.twitchChatChannel.findFirst({ where: { id: channelId, guildId } });
      if (!existing) throw new NotFoundError('Twitch chat channel not found.');

      await unlinkChannelFromGuild(app, { channel: existing, actor: { id: session.userId, platform: 'discord' } });
      reply.status(204);
      return null;
    },
  );
}
