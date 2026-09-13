import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import {
  ExternalServiceError,
  ValidationError,
  buildInviteUrl,
  env,
  isProduction,
  redisKey,
} from '@pavisie/core';
import { ensureGuild } from '@pavisie/database';
import { snowflakeSchema } from '../lib/schemas';
import type { SessionUser } from '@pavisie/types';
import { buildAuthorizeUrl, buildAvatarUrl, exchangeCode, fetchDiscordUser } from '../lib/discord';
import { requireAuth } from '../lib/guild-access';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  createSession,
  destroySession,
  type SessionData,
  setSessionCookie,
} from '../lib/session';

const AUTH_ROUTE_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
const OAUTH_STATE_TTL_SECONDS = 600;
const E2E_DEMO_GUILD_ID = '000000000000000000';
const E2E_DEMO_USER_ID = '100000000000000001';

// Binds the OAuth `state` to the initiating browser (RFC 6749 §10.12 login-CSRF protection). The Redis check
// alone only proves *some* login was started with this state — not that the browser completing the callback is
// the one that started it. `sameSite: 'lax'` (not 'strict') is required: the callback is a top-level GET
// navigation Discord redirects the browser to, which Lax cookies are sent on but Strict cookies are not.
const OAUTH_STATE_COOKIE_NAME = 'oauth_state';

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

function setOAuthStateCookie(reply: FastifyReply, state: string): void {
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

    const stateKey = redisKey('oauthstate', state);
    const stateOk = await app.redis.get(stateKey);
    if (!stateOk) {
      throw new ValidationError(
        'This login link has expired or was already used. Please try logging in again.',
      );
    }
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
