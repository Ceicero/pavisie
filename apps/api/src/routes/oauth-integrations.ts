import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import {
  AuditAction,
  ExternalServiceError,
  PermissionError,
  ValidationError,
  encryptSecret,
  env,
  redisKey,
} from '@pavisie/core';
import { writeDashboardAudit } from '../lib/audit';
import { requireAuth } from '../lib/guild-access';
import {
  OAUTH_PROVIDER_IDS,
  PROVIDER_ENUM_MAP,
  exchangeProviderCode,
  identifyTwitchUser,
  type OAuthProviderId,
} from '../lib/integrations/providers';
import { nudgeTwitchChatReconcile } from '../lib/integrations/twitch-chat-reconcile';

const paramsSchema = z.object({
  provider: z.enum(OAUTH_PROVIDER_IDS as [OAuthProviderId, ...OAuthProviderId[]]),
});
const querySchema = z.object({ code: z.string().min(1), state: z.string().min(1) });

/** Fixed id for the single `TwitchBotIdentity` row (ARCHITECTURE.md §19/§J) — deterministic rather than
 * "whichever row `findFirst` happens to see first", so two overlapping re-auths land on the same row via
 * `upsert` instead of racing to create a second one. No prod rows exist yet, so no migration is needed to
 * adopt this id for the (so far nonexistent) real singleton. */
const TWITCH_BOT_IDENTITY_ID = 'twitch-bot-identity';

/** Distinguishes the Twitch chat-bot flows from the original generic per-guild connect flow below, which is
 * unchanged and still carries no `kind` at all. See docs/ARCHITECTURE.md §J/§19. */
type TwitchChatOAuthKind = 'twitch_chat' | 'twitch_bot';

interface OAuthStatePayload {
  /** Present for every guild-scoped flow (the generic connect flow, and `kind: 'twitch_chat'`); absent for the
   * owner-only `kind: 'twitch_bot'` flow, which authorizes Pavisie's own account, not a per-guild link. */
  guildId?: string;
  provider: OAuthProviderId;
  userId: string;
  kind?: TwitchChatOAuthKind;
}

/** `/integrations/:provider/callback` — NOT guild-scoped in the URL (state carries the guildId) (ARCHITECTURE.md §10).
 * Requires a live session AND that session to belong to the same user who initiated the `/connect` flow — otherwise
 * an admin of one guild could hand a victim their own authorize URL and have the victim's OAuth grant (and its
 * tokens) land on the attacker's guild (account-linking CSRF).
 *
 * Branches on the state's `kind` (set by whichever `/connect` route created the state):
 * - absent (the original flow): generic per-guild `IntegrationConnection` + `OAuthToken`. For Twitch,
 *   additionally identifies the account via Helix and stores it as `externalAccountId`/`externalAccountName`
 *   (the login) — see the comment at that branch for why, and why every other provider here doesn't. A
 *   re-connect of an account already linked to this guild updates that row instead of creating a duplicate.
 * - `'twitch_chat'` (`routes/twitch-chat.ts`'s connect): identifies the broadcaster via Helix, then:
 *     - if this exact broadcaster is already linked from a *different* guild, bails out with an error
 *       redirect and creates nothing (one broadcaster's chat can only be linked into one guild at a time —
 *       otherwise Twitch's own EventSub subscription for that broadcaster would collide across guilds).
 *     - if this guild already had a connection for this broadcaster (a re-link), retires it first — status
 *       DISCONNECTED + `oAuthToken.deleteMany` — exactly like `routes/twitch-chat.ts`'s DELETE, so re-linking
 *       never orphans the previous connection/token.
 *     - creates the new connection + token, and upserts the guild's `TwitchChatChannel` row (status PENDING
 *       until the chat-bot manager's next reconcile tick subscribes it, nudged along below).
 * - `'twitch_bot'` (`routes/twitch-bot.ts`'s owner-only connect): identifies Pavisie's own Twitch account and
 *   upserts the single `TwitchBotIdentity` row (fixed id, see `TWITCH_BOT_IDENTITY_ID`), replacing
 *   tokens/scopes/expiry on re-auth.
 * Scopes are decided server-side only, by whichever `/connect` route built the authorize URL — this callback
 * never reads or trusts a scope from the request. */
export default async function oauthIntegrationsRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:provider/callback',
    { schema: { params: paramsSchema, querystring: querySchema }, preHandler: requireAuth },
    async (request, reply) => {
      const { provider } = request.params as { provider: OAuthProviderId };
      const { code, state } = request.query as { code: string; state: string };
      const session = request.session!;

      const stateKey = redisKey('oauthstate', 'integration', state);
      const raw = await app.redis.get(stateKey);
      if (!raw) {
        throw new ValidationError(
          'This integration link has expired or was already used. Please reconnect from the dashboard.',
        );
      }
      await app.redis.del(stateKey);
      const payload = JSON.parse(raw) as OAuthStatePayload;
      if (payload.provider !== provider) {
        throw new ValidationError('Provider mismatch on integration callback.');
      }
      if (payload.userId !== session.userId) {
        throw new PermissionError(
          'This integration link was started from a different account. Reconnect from the dashboard while logged in as the account that started it.',
        );
      }

      const redirectUri = `${env.API_BASE_URL ?? ''}/integrations/${provider}/callback`;
      const token = await exchangeProviderCode(provider, code, redirectUri);

      if (payload.kind === 'twitch_bot') {
        const twitchUser = await identifyTwitchUser(token.accessToken);
        if (!token.refreshToken || !token.expiresIn) {
          throw new ExternalServiceError('Twitch did not return a refresh token/expiry for the bot account.');
        }
        const scopes = token.scopes;
        const expiresAt = new Date(Date.now() + token.expiresIn * 1000);

        const data = {
          botUserId: twitchUser.id,
          botLogin: twitchUser.login,
          accessTokenEnc: encryptSecret(token.accessToken),
          refreshTokenEnc: encryptSecret(token.refreshToken),
          scopes,
          expiresAt,
          status: 'CONNECTED' as const,
          lastError: null,
        };
        // Deterministic singleton upsert on a fixed id rather than findFirst+create/update — two overlapping
        // re-auths (e.g. a double-click) both land on the same row instead of racing to create a second one.
        await app.prisma.twitchBotIdentity.upsert({
          where: { id: TWITCH_BOT_IDENTITY_ID },
          create: { id: TWITCH_BOT_IDENTITY_ID, ...data },
          update: data,
        });

        // The bot identity is shared by every guild's chat channel, so this isn't guild-scoped — nudge with
        // no guildId (see `nudgeTwitchChatReconcile`) rather than skip it: every channel's next send/read
        // depends on this token, so the bot should pick up a re-auth immediately, not on the next tick.
        nudgeTwitchChatReconcile(app, '');

        // No dashboard page owns this (owner-only, not part of the per-guild web dashboard) — a small
        // self-contained confirmation page avoids depending on a redirect target that may not exist.
        reply.type('text/html');
        return `<!doctype html><html><head><meta charset="utf-8"><title>Twitch bot connected</title></head><body style="font-family:system-ui,sans-serif;padding:2rem;text-align:center"><h1>Twitch bot connected</h1><p>Pavisie's Twitch bot account (@${twitchUser.login}) is authorized. You can close this tab.</p></body></html>`;
      }

      if (payload.kind === 'twitch_chat') {
        if (!payload.guildId) throw new ValidationError('Missing guild id on this integration link.');
        const guildId = payload.guildId;
        const twitchUser = await identifyTwitchUser(token.accessToken);

        // A broadcaster's Twitch chat can only be linked into one guild at a time (Twitch's own EventSub
        // subscription for that broadcaster is global, not per-guild — a second guild linking the same
        // broadcaster would otherwise fail with a cryptic 409 from Twitch once the chat-bot manager tried to
        // subscribe it there too). Look up every guild's link for this broadcaster once, up front.
        const existingLinksForBroadcaster = await app.prisma.twitchChatChannel.findMany({
          where: { broadcasterUserId: twitchUser.id },
        });
        const linkedToAnotherGuild = existingLinksForBroadcaster.find((row) => row.guildId !== guildId);
        if (linkedToAnotherGuild) {
          reply.redirect(
            `${env.DASHBOARD_URL}/dashboard/${guildId}/integrations?error=twitch-chat-already-linked`,
          );
          return;
        }

        // A re-link of this guild's own existing broadcaster: retire the old connection + token first —
        // exactly like `routes/twitch-chat.ts`'s DELETE — so re-linking never leaves the previous
        // connection/token dangling (CONNECTED forever, tokens never revoked from our side) once the new one
        // takes over below.
        const existingChannel = existingLinksForBroadcaster.find((row) => row.guildId === guildId);
        if (existingChannel?.connectionId) {
          await app.prisma.integrationConnection.update({
            where: { id: existingChannel.connectionId },
            data: { status: 'DISCONNECTED' },
          });
          await app.prisma.oAuthToken.deleteMany({ where: { connectionId: existingChannel.connectionId } });
        }

        const connection = await app.prisma.integrationConnection.create({
          data: {
            guildId,
            provider: PROVIDER_ENUM_MAP.twitch,
            label: `Twitch chat: ${twitchUser.login}`,
            status: 'CONNECTED',
            config: { kind: 'chat' },
            connectedBy: payload.userId,
          },
        });

        await app.prisma.oAuthToken.create({
          data: {
            connectionId: connection.id,
            accessTokenEnc: encryptSecret(token.accessToken),
            refreshTokenEnc: token.refreshToken ? encryptSecret(token.refreshToken) : undefined,
            tokenType: token.tokenType,
            scopes: token.scopes,
            expiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000) : undefined,
          },
        });

        await app.prisma.twitchChatChannel.upsert({
          where: { guildId_broadcasterUserId: { guildId, broadcasterUserId: twitchUser.id } },
          create: {
            guildId,
            broadcasterUserId: twitchUser.id,
            broadcasterLogin: twitchUser.login,
            status: 'PENDING',
            connectionId: connection.id,
            createdBy: payload.userId,
          },
          update: {
            broadcasterLogin: twitchUser.login,
            status: 'PENDING',
            lastError: null,
            connectionId: connection.id,
          },
        });

        await writeDashboardAudit(app.prisma, {
          guildId,
          actorId: payload.userId,
          action: AuditAction.IntegrationConnect,
          targetType: 'integration_connection',
          targetId: connection.id,
          after: { provider: 'twitch', kind: 'chat', broadcasterLogin: twitchUser.login },
        });

        nudgeTwitchChatReconcile(app, guildId);

        reply.redirect(`${env.DASHBOARD_URL}/dashboard/${guildId}/integrations?connected=twitch-chat`);
        return;
      }

      // Original generic connect flow. Twitch additionally identifies the account via Helix so the dashboard
      // can show a real handle instead of "Account <id>" (multi-account-integrations spec, section B), and so
      // `GET .../integrations/live` has a login to resolve at all — a generic Twitch connection is never
      // watched via the alerts flow (that's what carries `config.target`), so `externalAccountName` is the
      // only source it has. Google/Microsoft/Reddit have no identify call on their current scopes;
      // requesting one would mean broader scopes and storing an email address, which is a scope +
      // data-minimization decision out of scope for this fix — they keep the `Account <id>` fallback in the UI.
      let externalAccountId: string | null = null;
      let externalAccountName: string | null = null;
      if (provider === 'twitch') {
        // Non-fatal on purpose, unlike the `twitch_chat` branch above, which genuinely cannot proceed without
        // the broadcaster id. Here the identity is a nicety — the display name and the live pill — so a Helix
        // blip must not throw away an OAuth grant the user already completed and make them redo the whole
        // consent flow. Failing leaves both fields null: the card falls back to `Account <id>` and the live
        // lookup reports `live: null`, and reconnecting later fills them in.
        try {
          const twitchUser = await identifyTwitchUser(token.accessToken);
          externalAccountId = twitchUser.id;
          // The login, not the display name: Helix's `GET /streams?user_login=` (and the live-status lookup
          // built on it, `lib/integrations/live-status.ts`) matches on login, and a display name can differ
          // from it by more than case — e.g. a non-Latin display name — which would silently break that lookup.
          externalAccountName = twitchUser.login.toLowerCase();
        } catch (err) {
          app.log.warn(
            { err, guildId: payload.guildId },
            'integrations: Twitch identify failed during generic connect; linking without an account name',
          );
        }
      }

      // A re-connect of an account already linked to this guild updates that row in place instead of leaving
      // it next to a second, now-stale-looking one — the multi-account model still allows several *different*
      // accounts per guild/provider (`ProviderCard` renders a list), just not two rows for the same one.
      // Scoped to this guild only: unlike the `twitch_chat` kind above, a generic connection has no global
      // per-broadcaster subscription to collide across guilds, so there is no cross-guild guard to preserve
      // here (nor to weaken).
      const existingForAccount = externalAccountId
        ? await app.prisma.integrationConnection.findFirst({
            where: {
              guildId: payload.guildId!,
              provider: PROVIDER_ENUM_MAP[provider],
              externalAccountId,
              deletedAt: null,
            },
          })
        : null;

      const connection = existingForAccount
        ? await app.prisma.integrationConnection.update({
            where: { id: existingForAccount.id },
            data: {
              status: 'CONNECTED',
              externalAccountId,
              externalAccountName,
              connectedBy: payload.userId,
              lastError: null,
            },
          })
        : await app.prisma.integrationConnection.create({
            data: {
              guildId: payload.guildId!,
              provider: PROVIDER_ENUM_MAP[provider],
              status: 'CONNECTED',
              config: {},
              externalAccountId,
              externalAccountName,
              connectedBy: payload.userId,
            },
          });

      // `OAuthToken.connectionId` is unique (one token per connection) — a re-connect must clear the old
      // token row before creating the new one, exactly like the `twitch_chat` re-link above.
      if (existingForAccount) {
        await app.prisma.oAuthToken.deleteMany({ where: { connectionId: connection.id } });
      }
      await app.prisma.oAuthToken.create({
        data: {
          connectionId: connection.id,
          accessTokenEnc: encryptSecret(token.accessToken),
          refreshTokenEnc: token.refreshToken ? encryptSecret(token.refreshToken) : undefined,
          tokenType: token.tokenType,
          scopes: token.scopes,
          expiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000) : undefined,
        },
      });

      await writeDashboardAudit(app.prisma, {
        guildId: payload.guildId!,
        actorId: payload.userId,
        action: AuditAction.IntegrationConnect,
        targetType: 'integration_connection',
        targetId: connection.id,
        after: { provider, externalAccountName },
      });

      reply.redirect(`${env.DASHBOARD_URL}/dashboard/${payload.guildId}/integrations?connected=${provider}`);
    },
  );
}
