import { randomBytes } from 'node:crypto';
import type { ZodFastifyInstance } from '../lib/http';
import { NotFoundError } from '@pavisie/core';
import type { TwitchAccountLinkDto } from '@pavisie/types';
import { TWITCH_LINK_OAUTH_SCOPES, buildAuthorizeUrl } from '../lib/discord';
import { requireAuth } from '../lib/guild-access';
import { OAUTH_STATE_TTL_SECONDS, setOAuthStateCookie, twitchLinkStateKey } from './auth';

/**
 * `/me/twitch-link` — a Discord user's verified Twitch account link (ARCHITECTURE.md §19d). Foundation
 * only: nothing in the bot reads this yet (see `@pavisie/database`'s `findDiscordUserIdForTwitch`,
 * added ahead of that future work). The link is proven via Discord's own OAuth2 `connections` scope
 * (never a typed-in Twitch username — see `POST /connect`'s doc comment) and the actual grant/identify
 * exchange happens in `routes/auth.ts`'s shared `GET /discord/callback`, not here: this file only starts
 * the flow and reads/deletes the resulting row.
 */
export default async function twitchLinkRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get('/twitch-link', { preHandler: requireAuth }, async (request): Promise<TwitchAccountLinkDto> => {
    const session = request.session!;
    const link = await app.prisma.twitchAccountLink.findUnique({
      where: { discordUserId: session.userId },
    });
    if (!link) return { linked: false };
    return { linked: true, twitchLogin: link.twitchLogin, linkedAt: link.linkedAt.toISOString() };
  });

  // Requests `identify connections` — NOT `OAUTH_SCOPES` (`identify guilds`), and never merged into it:
  // this is the only flow in the app that ever asks Discord for `connections`, and it asks only when the
  // user explicitly clicks "Link Twitch" (least privilege — SPEC.md rule 3 / ARCHITECTURE.md §19d). The
  // resulting grant proves the user actually owns the linked Twitch account (Discord's own "verified"
  // flag on the connection), rather than letting them type an arbitrary Twitch name and claim it.
  app.post('/twitch-link/connect', { preHandler: requireAuth }, async (request, reply): Promise<{ url: string }> => {
    const session = request.session!;

    const state = randomBytes(24).toString('hex');
    // Own Redis key namespace (`twitchLinkStateKey`), distinct from the plain login state — the shared
    // callback in `routes/auth.ts` branches on which one exists. Payload binds the state to this
    // session's userId so the callback can refuse to complete a link for anyone else.
    await app.redis.set(
      twitchLinkStateKey(state),
      JSON.stringify({ userId: session.userId }),
      'EX',
      OAUTH_STATE_TTL_SECONDS,
    );
    // Same browser-binding cookie the login flow sets (`routes/auth.ts`'s `setOAuthStateCookie`, RFC 6749
    // §10.12) — the shared callback checks it once, before it even looks at which Redis key matched.
    setOAuthStateCookie(reply, state);

    return { url: buildAuthorizeUrl(state, TWITCH_LINK_OAUTH_SCOPES) };
  });

  app.delete('/twitch-link', { preHandler: requireAuth }, async (request, reply) => {
    const session = request.session!;
    const existing = await app.prisma.twitchAccountLink.findUnique({
      where: { discordUserId: session.userId },
    });
    if (!existing) {
      throw new NotFoundError('No linked Twitch account.');
    }
    await app.prisma.twitchAccountLink.delete({ where: { discordUserId: session.userId } });

    reply.status(204);
    return null;
  });
}
