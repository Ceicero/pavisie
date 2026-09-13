import { randomBytes } from 'node:crypto';
import type { ZodFastifyInstance } from '../lib/http';
import { ExternalServiceError, NotFoundError, env, redisKey } from '@pavisie/core';
import type { TwitchBotIdentityDto } from '@pavisie/types/integrations';
import { requireBotOwner } from '../lib/bot-owner';
import { toTwitchBotIdentityDto } from '../lib/integrations/dto';
import { buildProviderAuthorizeUrl, isOAuthProviderConfigured } from '../lib/integrations/providers';
import { nudgeTwitchChatReconcile } from '../lib/integrations/twitch-chat-reconcile';

/** Scopes for Pavisie's own Twitch bot account (ARCHITECTURE.md §19/§J) — never the generic Twitch
 * integration's scope, and never the per-guild `channel:bot` chat-channel scope (`routes/twitch-chat.ts`). */
const TWITCH_BOT_SCOPE = 'user:read:chat user:write:chat user:bot';

/**
 * `/owner/twitch-bot` — Pavisie's own Twitch bot account identity (one global row, `TwitchBotIdentity`),
 * authorized once by the bot owner. Every route here is gated on bot-owner identity (`requireBotOwner`), NOT
 * `requireGuildAccess` — same reasoning as `routes/owner-metrics.ts`/`routes/developer-reports.ts`: this is
 * intentionally cross-guild (there is exactly one bot account for the whole deployment), which is exactly why
 * it must never be reachable by a regular guild-managing dashboard session. Never returns the encrypted
 * access/refresh tokens (see `toTwitchBotIdentityDto`).
 */
export default async function twitchBotRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/twitch-bot',
    { preHandler: requireBotOwner() },
    async (): Promise<TwitchBotIdentityDto | { configured: false }> => {
      const row = await app.prisma.twitchBotIdentity.findFirst();
      return row ? toTwitchBotIdentityDto(row) : { configured: false };
    },
  );

  app.post(
    '/twitch-bot/connect',
    { preHandler: requireBotOwner() },
    async (request): Promise<{ url: string }> => {
      const session = request.session!;

      if (!isOAuthProviderConfigured('twitch')) {
        throw new ExternalServiceError('Twitch is not configured on this server.');
      }

      const state = randomBytes(24).toString('hex');
      // No `guildId` — this flow authorizes Pavisie's own account, not a per-guild channel link (contrast
      // `routes/twitch-chat.ts`'s `connect`, whose state carries `guildId`).
      await app.redis.set(
        redisKey('oauthstate', 'integration', state),
        JSON.stringify({ provider: 'twitch', userId: session.userId, kind: 'twitch_bot' }),
        'EX',
        600,
      );

      const redirectUri = `${env.API_BASE_URL ?? ''}/integrations/twitch/callback`;
      return { url: buildProviderAuthorizeUrl('twitch', state, redirectUri, TWITCH_BOT_SCOPE) };
    },
  );

  app.delete('/twitch-bot', { preHandler: requireBotOwner() }, async (_request, reply) => {
    const existing = await app.prisma.twitchBotIdentity.findFirst();
    if (!existing) throw new NotFoundError('Twitch bot identity is not configured.');

    await app.prisma.twitchBotIdentity.delete({ where: { id: existing.id } });

    // Global, not guild-scoped (see `nudgeTwitchChatReconcile`) — every guild's chat channel just lost its
    // credentials, so the bot should drop them right away instead of failing sends until the next tick.
    nudgeTwitchChatReconcile(app, '');

    reply.status(204);
    return null;
  });
}
