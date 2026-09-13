// "Live now" lookups for `GET /guilds/:guildId/integrations/live` (routes/integrations.ts) — see
// docs/ARCHITECTURE.md §10 and the multi-account-integrations spec. Twitch is the only provider with a real,
// cheaply-checkable live/offline concept: Helix's app-credential `GET /streams` endpoint. YouTube's only
// live-status signal (`search.list?eventType=live`) costs 100 quota units per call with no free/app-only
// alternative, so this deliberately does not add a YouTube path here — the route reports `live: null` for it,
// same as every other provider with no live concept at all (CLAUDE.md "No fake content": an unknown state is
// `null`, never a guessed `false`).
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { env, redisKey } from '@pavisie/core';
import { getTwitchAppToken, type TwitchAppTokenContext } from '@pavisie/plugins/integrations/providers/twitch';

/** Helix documents a 100-`user_login`-per-request limit on `GET /streams` — batch any larger set into chunks
 * of this size rather than one call per login. */
const HELIX_STREAMS_BATCH_SIZE = 100;

/** How long a per-login result is trusted before the dashboard's next 60s poll should re-check Helix —
 * matches the dashboard's own `refetchInterval`, so a cache hit is the common case, not a coincidence. */
const LIVE_CACHE_TTL_SECONDS = 60;

export interface TwitchLiveResult {
  live: boolean;
  title: string | null;
  startedAt: string | null;
}

interface HelixStreamsResponse {
  data: { user_login: string; title?: string; started_at?: string }[];
}

function liveCacheKey(login: string): string {
  return redisKey('integrations', 'live', 'twitch', login);
}

/** Minimal context `fetchTwitchLiveStatuses` needs — the same env/redis/logger slice `getTwitchAppToken`
 * itself accepts, so `apps/api` can build one from a Fastify instance without a full `PluginContext`. */
export type TwitchLiveStatusContext = TwitchAppTokenContext;

/**
 * Looks up live status for a set of Twitch logins, batching Helix's `/streams` endpoint at up to 100
 * `user_login` params per call and caching each login's result in Redis for 60s so an idle dashboard polling
 * `GET /guilds/:guildId/integrations/live` costs zero Twitch quota between polls. Never queries a
 * broadcaster's or the bot's own user token — only the shared app (client-credentials) token.
 *
 * Returns a `Map` keyed by lowercased login. A login missing from the map, or present with value `null`,
 * both mean "could not be determined" (Twitch not configured, app token unavailable, or the Helix request
 * failed) — callers must surface that as `live: null`, never guess `false`. Only genuinely successful Helix
 * responses are cached; a failure is retried on the caller's next request instead of being pinned to `null`
 * for the full TTL.
 */
export async function fetchTwitchLiveStatuses(
  ctx: TwitchLiveStatusContext,
  logins: string[],
): Promise<Map<string, TwitchLiveResult | null>> {
  const results = new Map<string, TwitchLiveResult | null>();
  const uniqueLogins = [...new Set(logins.map((login) => login.toLowerCase()).filter(Boolean))];
  if (uniqueLogins.length === 0) return results;

  const toFetch: string[] = [];
  for (const login of uniqueLogins) {
    const cached = await ctx.redis.get(liveCacheKey(login));
    if (cached) {
      try {
        results.set(login, JSON.parse(cached) as TwitchLiveResult);
        continue;
      } catch {
        // Fall through and re-fetch — a corrupt cache entry shouldn't wedge this login at `null` for a full TTL.
      }
    }
    toFetch.push(login);
  }
  if (toFetch.length === 0) return results;

  const clientId = ctx.env.TWITCH_CLIENT_ID;
  const token = clientId ? await getTwitchAppToken(ctx) : null;
  if (!token || !clientId) {
    for (const login of toFetch) results.set(login, null);
    return results;
  }

  for (let i = 0; i < toFetch.length; i += HELIX_STREAMS_BATCH_SIZE) {
    const chunk = toFetch.slice(i, i + HELIX_STREAMS_BATCH_SIZE);
    const params = new URLSearchParams();
    for (const login of chunk) params.append('user_login', login);

    let json: HelixStreamsResponse | null = null;
    try {
      const res = await fetch(`https://api.twitch.tv/helix/streams?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
      });
      if (res.ok) {
        json = (await res.json()) as HelixStreamsResponse;
      } else {
        ctx.logger.warn({ status: res.status }, 'integrations/live: Twitch Helix /streams request failed');
      }
    } catch (err) {
      ctx.logger.warn({ err }, 'integrations/live: Twitch Helix /streams request threw');
    }

    if (!json) {
      // A Helix outage must never render every streamer in the chunk as offline — leave each as unresolved
      // (`null`) so the route reports "unknown", not a fabricated `false`.
      for (const login of chunk) results.set(login, null);
      continue;
    }

    const liveByLogin = new Map(json.data.map((stream) => [stream.user_login.toLowerCase(), stream]));
    for (const login of chunk) {
      const stream = liveByLogin.get(login);
      const result: TwitchLiveResult = stream
        ? { live: true, title: stream.title ?? null, startedAt: stream.started_at ?? null }
        : { live: false, title: null, startedAt: null };
      results.set(login, result);
      await ctx.redis.set(liveCacheKey(login), JSON.stringify(result), 'EX', LIVE_CACHE_TTL_SECONDS);
    }
  }

  return results;
}

/** Builds the minimal context `fetchTwitchLiveStatuses`/`getTwitchAppToken` need from `ZodFastifyInstance` —
 * `app.redis` and `app.log` are the exact same `Redis`/pino-`Logger` types `PluginContext` uses (see
 * `lib/http.ts`'s `ZodFastifyInstance`), so no adapter beyond this object literal is needed. */
export function twitchLiveStatusContextFrom(app: { redis: Redis; log: Logger }): TwitchLiveStatusContext {
  return { env, redis: app.redis, logger: app.log };
}
