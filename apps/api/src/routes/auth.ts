import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import {
  ExternalServiceError,
  PermissionError,
  ValidationError,
  buildInviteUrl,
  env,
  isProduction,
  redisKey,
} from '@pavisie/core';
import { Prisma, ensureGuild } from '@pavisie/database';
import { snowflakeSchema } from '../lib/schemas';
import type { SessionUser } from '@pavisie/types';
import {
  buildAuthorizeUrl,
  buildAvatarUrl,
  exchangeCode,
  fetchDiscordConnections,
  fetchDiscordUser,
} from '../lib/discord';
import { UnauthenticatedError, requireAuth } from '../lib/guild-access';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  createSession,
  destroySession,
  type SessionData,
  setSessionCookie,
} from '../lib/session';

const AUTH_ROUTE_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
/** Also used by `routes/twitch-link.ts`'s `/connect`, which stores its own state under a distinct Redis
 * key namespace (`redisKey('oauthstate', 'twitchlink', state)`) but shares this TTL (ARCHITECTURE.md §19d). */
export const OAUTH_STATE_TTL_SECONDS = 600;
const E2E_DEMO_GUILD_ID = '000000000000000000';
const E2E_DEMO_USER_ID = '100000000000000001';

// Binds the OAuth `state` to the initiating browser (RFC 6749 §10.12 login-CSRF protection). The Redis check
// alone only proves *some* login was started with this state — not that the browser completing the callback is
// the one that started it. `sameSite: 'lax'` (not 'strict') is required: the callback is a top-level GET
// navigation Discord redirects the browser to, which Lax cookies are sent on but Strict cookies are not.
// Exported so `routes/twitch-link.ts`'s `/connect` can set the same cookie for its own authorize redirect —
// both flows land back on this file's `/discord/callback`, which checks it once, before branching.
export const OAUTH_STATE_COOKIE_NAME = 'oauth_state';

function toSessionUser(session: SessionData): SessionUser {
  return {
    id: session.userId,
    username: session.username,
    globalName: session.globalName,
    avatarUrl: session.avatarUrl,
  };
}

interface CookieCapableRequest {
  cookies: Record<string, string | undefined>;
  unsignCookie: (v: string) => { valid: boolean; value: string | null };
}

function currentSid(request: CookieCapableRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE_NAME];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

function readSignedCookie(request: CookieCapableRequest, name: string): string | null {
  const raw = request.cookies[name];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

export function setOAuthStateCookie(reply: FastifyReply, state: string): void {
  reply.setCookie(OAUTH_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: OAUTH_STATE_TTL_SECONDS,
    signed: true,
  });
}

function clearOAuthStateCookie(reply: FastifyReply): void {
  reply.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/' });
}

const callbackQuerySchema = z.object({ code: z.string().min(1), state: z.string().min(1) });
const inviteQuerySchema = z.object({ guild_id: snowflakeSchema.optional() });

/** Redis key for a pending twitch-link `/connect` state — a distinct namespace from the plain login
 * state (`redisKey('oauthstate', state)`) so the callback below can tell which flow a given `state`
 * belongs to just by which key exists, and so a login state and a link state can never collide even if
 * (implausibly) generated with the same random value. Exported for `routes/twitch-link.ts`'s `/connect`,
 * which writes this key; the callback here is the only reader. */
export function twitchLinkStateKey(state: string): string {
  return redisKey('oauthstate', 'twitchlink', state);
}

/** Payload stored at `twitchLinkStateKey` — binds the state to the session that started the flow, so the
 * callback can refuse to complete a link for anyone else (account-linking CSRF guard, same reasoning as
 * `routes/oauth-integrations.ts`'s callback). */
interface TwitchLinkStatePayload {
  userId: string;
}

/** Query-string error codes `GET /discord/callback`'s twitch-link branch redirects the web account page
 * with — matched by `apps/web`'s account page to a human-readable message. Never thrown as an exposed API
 * error, since by this point the flow has left JSON-land and is a full-page redirect. */
const TWITCH_LINK_ERROR = {
  noVerifiedConnection: 'twitch-link-no-verified-connection',
  multipleConnections: 'twitch-link-multiple-connections',
  alreadyClaimed: 'twitch-link-already-claimed',
} as const;

function twitchLinkRedirect(reply: FastifyReply, query: string): void {
  reply.redirect(`${env.DASHBOARD_URL}/dashboard/account${query}`);
}

/** `/auth/*` — Discord OAuth login/callback/logout/me, plus a test-only login shortcut for e2e tests (ARCHITECTURE.md §10). */
export default async function authRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get('/discord/login', AUTH_ROUTE_RATE_LIMIT, async (_request, reply) => {
    const state = randomBytes(24).toString('hex');
    await app.redis.set(redisKey('oauthstate', state), '1', 'EX', OAUTH_STATE_TTL_SECONDS);
    setOAuthStateCookie(reply, state);
    reply.redirect(buildAuthorizeUrl(state));
  });

  // The dashboard's "Add Pavisie" / "Add to a server" links point here (never Administrator — buildInviteUrl
  // always strips it). Optional `guild_id` pre-selects the target server and locks the Discord picker to it.
  app.get(
    '/invite',
    { ...AUTH_ROUTE_RATE_LIMIT, schema: { querystring: inviteQuerySchema } },
    async (request, reply) => {
      if (!env.DISCORD_CLIENT_ID) {
        throw new ExternalServiceError('Discord OAuth is not configured.');
      }
      const { guild_id: guildId } = request.query;
      let url = buildInviteUrl(env.DISCORD_CLIENT_ID);
      if (guildId) {
        url += `&guild_id=${encodeURIComponent(guildId)}&disable_guild_select=true`;
      }
      reply.redirect(url);
    },
  );

  app.get('/discord/callback', AUTH_ROUTE_RATE_LIMIT, async (request, reply) => {
    const parsed = callbackQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ValidationError('Missing or invalid OAuth code/state.');
    }
    const { code, state } = parsed.data;

    const cookieState = readSignedCookie(request, OAUTH_STATE_COOKIE_NAME);
    if (!cookieState || cookieState !== state) {
      throw new ValidationError(
        'This login link does not match the browser that started it. Please try logging in again.',
      );
    }
    clearOAuthStateCookie(reply);

    // Which Redis key holds this state decides which flow this callback is completing — see
    // `twitchLinkStateKey`'s doc comment. Login is checked first and its behavior is byte-for-byte
    // unchanged from before the twitch-link flow existed.
    const stateKey = redisKey('oauthstate', state);
    const stateOk = await app.redis.get(stateKey);
    if (stateOk) {
      await app.redis.del(stateKey);

      const token = await exchangeCode(code);
      const discordUser = await fetchDiscordUser(token.access_token);

      const { sid } = await createSession(app.redis, {
        userId: discordUser.id,
        username: discordUser.username,
        globalName: discordUser.global_name,
        avatarUrl: buildAvatarUrl(discordUser.id, discordUser.avatar),
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresInSec: token.expires_in,
      });

      setSessionCookie(reply, sid);
      reply.redirect(`${env.DASHBOARD_URL}/dashboard`);
      return;
    }

    const linkKey = twitchLinkStateKey(state);
    const linkRaw = await app.redis.get(linkKey);
    if (!linkRaw) {
      throw new ValidationError(
        'This login link has expired or was already used. Please try logging in again.',
      );
    }
    await app.redis.del(linkKey);
    const linkPayload = JSON.parse(linkRaw) as TwitchLinkStatePayload;

    // The twitch-link flow never creates or modifies a login session — it requires one to already exist
    // (set by `POST /me/twitch-link/connect`'s `requireAuth`) and only ever reads it.
    if (!request.session) {
      throw new UnauthenticatedError();
    }
    const session = request.session;

    const token = await exchangeCode(code);
    const discordUser = await fetchDiscordUser(token.access_token);

    // Account-linking CSRF guard (same reasoning as `routes/oauth-integrations.ts`'s callback): the
    // Discord identity this OAuth grant belongs to must be BOTH the one that started the flow (the
    // state's bound userId) AND the one currently signed in — otherwise an attacker could hand a victim
    // their own `/connect` authorize URL and have the victim's Twitch connection land on the attacker's
    // Discord account.
    if (discordUser.id !== linkPayload.userId || discordUser.id !== session.userId) {
      throw new PermissionError(
        'This Twitch link was started from a different Discord account. Reconnect from your account page while signed in as the account that started it.',
      );
    }

    // `token.access_token` is used only for this one Helix-adjacent call and then discarded — never
    // persisted to the database and never logged (only the outcome code below is).
    const connections = await fetchDiscordConnections(token.access_token);
    const verifiedTwitch = connections.filter((c) => c.type === 'twitch' && c.verified === true);

    if (verifiedTwitch.length === 0) {
      app.log.info({ outcome: TWITCH_LINK_ERROR.noVerifiedConnection }, 'twitch-link: callback bailed out');
      twitchLinkRedirect(reply, `?error=${TWITCH_LINK_ERROR.noVerifiedConnection}`);
      return;
    }
    if (verifiedTwitch.length > 1) {
      app.log.info({ outcome: TWITCH_LINK_ERROR.multipleConnections }, 'twitch-link: callback bailed out');
      twitchLinkRedirect(reply, `?error=${TWITCH_LINK_ERROR.multipleConnections}`);
      return;
    }

    const twitchConnection = verifiedTwitch[0]!;
    const existingForTwitch = await app.prisma.twitchAccountLink.findUnique({
      where: { twitchUserId: twitchConnection.id },
    });
    if (existingForTwitch && existingForTwitch.discordUserId !== discordUser.id) {
      app.log.info({ outcome: TWITCH_LINK_ERROR.alreadyClaimed }, 'twitch-link: callback bailed out');
      twitchLinkRedirect(reply, `?error=${TWITCH_LINK_ERROR.alreadyClaimed}`);
      return;
    }

    try {
      await app.prisma.twitchAccountLink.upsert({
        where: { discordUserId: discordUser.id },
        create: {
          discordUserId: discordUser.id,
          twitchUserId: twitchConnection.id,
          twitchLogin: twitchConnection.name,
        },
        update: { twitchUserId: twitchConnection.id, twitchLogin: twitchConnection.name },
      });
    } catch (err) {
      // Narrow race with a concurrent link of the same Twitch account by someone else, between the
      // proactive `findUnique` check above and this write — the unique constraint on `twitchUserId` is
      // the actual guarantee (same pattern as `nextCaseNumber`'s doc comment in `@pavisie/database`).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        app.log.info({ outcome: TWITCH_LINK_ERROR.alreadyClaimed }, 'twitch-link: callback bailed out');
        twitchLinkRedirect(reply, `?error=${TWITCH_LINK_ERROR.alreadyClaimed}`);
        return;
      }
      throw err;
    }

    app.log.info({ outcome: 'linked' }, 'twitch-link: callback linked a Twitch account');
    twitchLinkRedirect(reply, '?linked=twitch');
  });

  app.post('/logout', AUTH_ROUTE_RATE_LIMIT, async (request, reply) => {
    const sid = currentSid(request);
    if (sid) {
      await destroySession(app.redis, sid);
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/me', { ...AUTH_ROUTE_RATE_LIMIT, preHandler: requireAuth }, async (request) => {
    const session = request.session!;
    return { user: toSessionUser(session), csrfToken: session.csrfToken };
  });

  // Only registered when E2E_TEST_MODE=true AND NODE_ENV!=='production' (never available in prod, regardless
  // of the flag) — used by Playwright to skip the real Discord OAuth dance (ARCHITECTURE.md §10).
  if (env.E2E_TEST_MODE && !isProduction) {
    app.post('/test-login', AUTH_ROUTE_RATE_LIMIT, async (request, reply) => {
      await ensureGuild(app.prisma, {
        id: E2E_DEMO_GUILD_ID,
        name: 'Pavisie Demo (seed)',
        ownerId: E2E_DEMO_USER_ID,
      });

      // Pre-seed the cached Discord guild list so `requireGuildAccess` doesn't need a real Discord token.
      await app.redis.set(
        redisKey('userguilds', E2E_DEMO_USER_ID),
        JSON.stringify([
          { id: E2E_DEMO_GUILD_ID, name: 'Pavisie Demo (seed)', icon: null, owner: true, permissions: '8' },
        ]),
        'EX',
        OAUTH_STATE_TTL_SECONDS,
      );

      const { sid, session } = await createSession(app.redis, {
        userId: E2E_DEMO_USER_ID,
        username: 'e2e-test-user',
        globalName: 'E2E Test User',
        avatarUrl: null,
        accessToken: 'e2e-fake-access-token',
        refreshToken: 'e2e-fake-refresh-token',
        expiresInSec: 3600,
      });

      setSessionCookie(reply, sid);
      return { user: toSessionUser(session), csrfToken: session.csrfToken };
    });
  }
}
