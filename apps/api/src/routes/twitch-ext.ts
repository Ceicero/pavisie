// `/twitch-ext/*` — the Extension Backend Service (EBS) for the Agis Twitch Extension panel
// (ARCHITECTURE.md §19d). Bearer-JWT authenticated (no dashboard cookie/session, no CSRF token), served to a
// DIFFERENT origin than the dashboard (`https://<TWITCH_EXTENSION_CLIENT_ID>.ext-twitch.tv`, Twitch's
// extension-hosting origin) — so this file owns its own CORS instead of using `app.ts`'s dashboard-only
// `@fastify/cors` registration, and is exempted from CSRF in `lib/csrf.ts` (see the comment there).
//
// CORS is hand-rolled here rather than a second `@fastify/cors` registration: `@fastify/cors` is wrapped with
// `fastify-plugin`, so a second registration's auto-generated `OPTIONS *` preflight route would still run
// `app.ts`'s ROOT cors hook first (parent hooks always run before a child scope's), and that root hook replies
// to every `OPTIONS` request itself (200/204, no ACAO header for a non-dashboard origin) before a nested cors
// plugin ever gets a turn — silently breaking the extension's real preflight. `config: { cors: false }` on
// every route below (see `@fastify/cors`'s own "Allow routes to disable CORS individually" escape hatch) tells
// the ROOT plugin to skip these routes entirely, so this file's own `onRequest` hook is the only thing that
// runs. This plugin function is its own encapsulation context (a plain, non-`fastify-plugin`-wrapped async
// function registered with a prefix in `app.ts`), so this hook and the explicit `OPTIONS` routes below apply
// ONLY to `/twitch-ext/*` — never widening CORS for any other route.

import { AppError, env } from '@pavisie/core';
import { claimChannelDaily, getChannelEarnedLeaderboard } from '@pavisie/plugins/channel-economy/ledger';
import { pickChannelEconomySettings, toRollDailyConfig } from '@pavisie/plugins/channel-economy/settings';
import type { ZodFastifyInstance } from '../lib/http';
import { requireTwitchExtensionAuth, twitchExtensionRateLimitKey } from '../lib/twitch-ext/auth';
import { resolveTwitchExtChannelContext } from '../lib/twitch-ext/context';
import { readChannelWalletSummary } from '../lib/twitch-ext/wallet-summary';

const LEADERBOARD_LIMIT = 10;

function extensionOrigin(): string | null {
  return env.TWITCH_EXTENSION_CLIENT_ID ? `https://${env.TWITCH_EXTENSION_CLIENT_ID}.ext-twitch.tv` : null;
}

const CORS_ROUTE_CONFIG = { cors: false } as const;
const RATE_LIMIT = { max: 30, timeWindow: '1 minute', keyGenerator: twitchExtensionRateLimitKey } as const;

type SummaryResponse = {
  enabled: boolean;
  currencyName?: string;
  currencySymbol?: string;
  identityShared?: boolean;
  wallet?: { balance: string; dailyAvailableAt: string | null; streak: number };
  leaderboard?: Array<{ displayName: string; earned: string }>;
};

type DailyResponse = { ok: boolean; amount?: string; streak?: number; retryAfterMs?: number };

export default async function twitchExtRoutes(app: ZodFastifyInstance): Promise<void> {
  // Manual CORS for this plugin's routes only — see the file-level comment for why `@fastify/cors` isn't
  // reused here. Runs before auth (an OPTIONS preflight carries no Authorization header at all, and even a
  // rejected/expired-token GET should still get a correct CORS header so the browser lets the JS see the 401).
  app.addHook('onRequest', async (request, reply) => {
    const origin = extensionOrigin();
    if (origin && request.headers.origin === origin) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      // Deliberately NO `Access-Control-Allow-Credentials` header — these requests never carry cookies
      // (bearer-token auth only), matching the task's "without credentials" requirement.
    }

    if (request.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      const requestedHeaders = request.headers['access-control-request-headers'];
      reply.header(
        'Access-Control-Allow-Headers',
        typeof requestedHeaders === 'string' ? requestedHeaders : 'Authorization, Content-Type',
      );
      reply.header('Access-Control-Max-Age', '600');
      reply.status(204);
      return reply.send();
    }
  });

  // Explicit preflight routes so Fastify's router picks THIS plugin's (more specific, `/twitch-ext/*`) match
  // over `app.ts`'s root-level `@fastify/cors`-registered `OPTIONS *` wildcard — routing determines which
  // route's hook chain runs, and only a route registered inside this plugin runs the `onRequest` hook above.
  app.options('/summary', { config: CORS_ROUTE_CONFIG }, async (_request, reply) => {
    reply.status(204);
    return null;
  });
  app.options('/daily', { config: CORS_ROUTE_CONFIG }, async (_request, reply) => {
    reply.status(204);
    return null;
  });

  app.get<{ Reply: SummaryResponse }>(
    '/summary',
    {
      config: { ...CORS_ROUTE_CONFIG, rateLimit: RATE_LIMIT },
      preHandler: requireTwitchExtensionAuth,
    },
    async (request): Promise<SummaryResponse> => {
      const payload = request.twitchExt!;
      const channelContext = await resolveTwitchExtChannelContext(app, payload.channelId);
      if (!channelContext) return { enabled: false };

      const { economy } = channelContext;
      const identityShared = payload.userId !== null;

      const leaderboardRows = await getChannelEarnedLeaderboard(app.prisma, economy.id, LEADERBOARD_LIMIT);
      const leaderboard = leaderboardRows.map((row) => ({
        displayName: row.displayName ?? 'Twitch viewer',
        earned: row.earned.toString(),
      }));

      const response: SummaryResponse = {
        enabled: true,
        currencyName: economy.currencyName,
        currencySymbol: economy.currencySymbol,
        identityShared,
        leaderboard,
      };

      // Never create a wallet just for viewing — read-only, absent wallet reads as a zero balance.
      if (identityShared) {
        const summary = await readChannelWalletSummary(app, economy.id, payload.userId!);
        response.wallet = {
          balance: summary.balance.toString(),
          dailyAvailableAt: summary.dailyAvailableAt ? summary.dailyAvailableAt.toISOString() : null,
          streak: summary.streak,
        };
      }

      return response;
    },
  );

  app.post<{ Reply: DailyResponse }>(
    '/daily',
    {
      config: { ...CORS_ROUTE_CONFIG, rateLimit: RATE_LIMIT },
      preHandler: requireTwitchExtensionAuth,
    },
    async (request): Promise<DailyResponse> => {
      const payload = request.twitchExt!;

      if (!payload.userId) {
        throw new AppError(
          'identity_not_shared',
          'Share your Twitch identity with the extension to claim your daily reward.',
          { status: 403, expose: true },
        );
      }

      const channelContext = await resolveTwitchExtChannelContext(app, payload.channelId);
      if (!channelContext) return { ok: false };

      const { economy } = channelContext;
      const result = await claimChannelDaily(
        app.prisma,
        { economyId: economy.id, viewerUserId: payload.userId },
        toRollDailyConfig(pickChannelEconomySettings(economy)),
        new Date(),
        Math.random,
      );

      if (!result.ok) {
        return { ok: false, retryAfterMs: result.retryAfterMs };
      }
      return { ok: true, amount: result.amount.toString(), streak: result.streak };
    },
  );
}
