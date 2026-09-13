// Steam Web API client for the `gamestats` plugin. Steam-only by design — there is no public stats API for
// console platforms (SPEC.md "Non-negotiables") — and every function here degrades to a typed failure rather
// than guessing when `STEAM_API_KEY` is unset. Mirrors `integrations/providers/twitch.ts`'s thin-fetch-wrapper
// style: no retry/backoff logic here (the caller — `service.ts`/the refresh job — decides what to do with a
// failure), and the API key is NEVER logged, only HTTP status codes.
import { redisKey } from '@pavisie/core';
import type { PluginContext } from '../sdk';

const API_BASE = 'https://api.steampowered.com';

/** How long a `getGameStats` result is Redis-cached, per (appId, steamId) — absorbs repeat calls from a
 *  leaderboard render or a `/dbd stats` lookup shortly after the 30-minute refresh job already fetched it. */
const STATS_CACHE_TTL_SECONDS = 600;

const STEAM_ID64_RE = /^\d{17}$/;
const PROFILE_ID64_RE = /steamcommunity\.com\/profiles\/(\d{17})/i;
const PROFILE_VANITY_RE = /steamcommunity\.com\/id\/([^/?#]+)/i;

export type ResolveSteamIdResult =
  | { ok: true; steamId64: string }
  | { ok: false; error: 'not_found' | 'error' };

export type GetGameStatsResult =
  | { ok: true; stats: Record<string, number> }
  | { ok: false; reason: 'private' | 'no_game' | 'error' | 'transient' };

export interface GetGameStatsOptions {
  /** Skips the Redis cache read (a fresh result is still written to Redis afterward) — used by `/dbd refresh`
   *  and `/dbd link`'s live validation call, both of which need to observe the member's CURRENT Steam state
   *  rather than whatever was cached up to `STATS_CACHE_TTL_SECONDS` ago. */
  bypassCache?: boolean;
  /** Curates the stats map down to exactly these provider stat keys before it is cached or returned — the raw
   *  full Steam payload must never touch Redis or a caller (data minimization, SPEC.md "Non-negotiables": "never
   *  the full Steam payload"). Every caller should pass its game descriptor's own provider stat keys
   *  (`games/index.ts`'s `providerStatKeys`). Omitting this returns/caches the stats map unfiltered — only safe
   *  for call sites that have no descriptor to curate against. */
  keepKeys?: string[];
}

/** Subsets `stats` down to `keepKeys` (provider stat names), dropping everything else. A no-op when `keepKeys`
 *  is omitted. Applied to every value this module caches or returns from a live fetch, and defensively re-applied
 *  on a cache hit too, so a `keepKeys`-less caller can never leak an uncurated cached payload back out. */
function curateForCache(stats: Record<string, number>, keepKeys?: string[]): Record<string, number> {
  if (!keepKeys) return stats;
  const curated: Record<string, number> = {};
  for (const key of keepKeys) {
    if (key in stats) curated[key] = stats[key]!;
  }
  return curated;
}

export interface SteamPlayerSummary {
  steamId: string;
  personaName: string;
  profileUrl: string;
  /** Steam's `communityvisibilitystate`: 1 = private, 2 = "friends only", 3 = public. */
  visibility: number;
}

interface ResolveVanityResponse {
  response: { success: number; steamid?: string; message?: string };
}
interface PlayerSummariesResponse {
  response: {
    players: { steamid: string; personaname: string; profileurl: string; communityvisibilitystate: number }[];
  };
}
interface UserStatsResponse {
  playerstats?: { steamID: string; gameName: string; stats?: { name: string; value: number }[] };
}

function logRequestFailure(ctx: PluginContext, op: string, detail: Record<string, unknown>): void {
  // Never includes the request URL/params (would leak the API key) — status codes and ids only.
  ctx.logger.warn(detail, `gamestats/steam: ${op}`);
}

/** Resolves a Steam vanity URL segment to a SteamID64 (`ISteamUser/ResolveVanityURL/v1`). Only called when the
 *  input isn't already a recognizable SteamID64 or profile URL. */
async function resolveVanity(ctx: PluginContext, apiKey: string, vanity: string): Promise<ResolveSteamIdResult> {
  const params = new URLSearchParams({ key: apiKey, vanityurl: vanity });
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/ISteamUser/ResolveVanityURL/v1/?${params.toString()}`);
  } catch (err) {
    logRequestFailure(ctx, 'resolve vanity request threw', { err: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: 'error' };
  }
  if (!res.ok) {
    logRequestFailure(ctx, 'resolve vanity request failed', { status: res.status });
    return { ok: false, error: 'error' };
  }
  const json = (await res.json()) as ResolveVanityResponse;
  if (json.response.success === 1 && json.response.steamid) {
    return { ok: true, steamId64: json.response.steamid };
  }
  return { ok: false, error: 'not_found' };
}

/**
 * Accepts a SteamID64 (`^\d{17}$`), a `steamcommunity.com/profiles/<id64>` or `/id/<vanity>` URL, or a bare
 * vanity name, and resolves it to a SteamID64 — only hitting Steam's vanity-resolve endpoint (which needs
 * `STEAM_API_KEY`) when the input isn't already a raw id64 or a `/profiles/` URL that already carries one.
 */
export async function resolveSteamId(ctx: PluginContext, input: string): Promise<ResolveSteamIdResult> {
  const trimmed = input.trim();
  if (STEAM_ID64_RE.test(trimmed)) return { ok: true, steamId64: trimmed };

  const profileId64Match = PROFILE_ID64_RE.exec(trimmed);
  if (profileId64Match) return { ok: true, steamId64: profileId64Match[1]! };

  const apiKey = ctx.env.STEAM_API_KEY;
  if (!apiKey) return { ok: false, error: 'error' };

  const vanityMatch = PROFILE_VANITY_RE.exec(trimmed);
  const vanity = vanityMatch ? vanityMatch[1]! : trimmed;
  if (!vanity) return { ok: false, error: 'not_found' };
  return resolveVanity(ctx, apiKey, vanity);
}

/**
 * Persona name + profile visibility (`ISteamUser/GetPlayerSummaries/v2`). Returns `null` on ANY failure —
 * missing key, network error, non-2xx, or an empty `players` array — callers treat that the same as "couldn't
 * refresh the cached name right now", never as a fatal error for the stats refresh itself.
 */
export async function getPlayerSummary(ctx: PluginContext, steamId: string): Promise<SteamPlayerSummary | null> {
  const apiKey = ctx.env.STEAM_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({ key: apiKey, steamids: steamId });
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/ISteamUser/GetPlayerSummaries/v2/?${params.toString()}`);
  } catch (err) {
    logRequestFailure(ctx, 'player summary request threw', { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (!res.ok) {
    logRequestFailure(ctx, 'player summary request failed', { status: res.status });
    return null;
  }
  const json = (await res.json()) as PlayerSummariesResponse;
  const player = json.response.players[0];
  if (!player) return null;
  return {
    steamId: player.steamid,
    personaName: player.personaname,
    profileUrl: player.profileurl,
    visibility: player.communityvisibilitystate,
  };
}

/**
 * Raw per-stat map for one game (`ISteamUserStats/GetUserStatsForGame/v2`), Redis-cached for
 * `STATS_CACHE_TTL_SECONDS` under `redisKey('gamestats','steam','stats',appId,steamId)` — pass `options.bypassCache`
 * to skip the cache read (the fresh result is still cached afterward) and `options.keepKeys` to curate what gets
 * cached/returned down to a game descriptor's own provider stat keys (see `GetGameStatsOptions`).
 *
 * Steam has no dedicated error code for "this player's Game details privacy isn't Public" on this endpoint — a
 * 403 reliably means that, and maps straight to `reason: 'private'` so `/dbd link` can point the member at the
 * exact Steam setting to fix instead of showing a generic error. A 500, though, is Steam's generic "something
 * went wrong" status — it does NOT reliably mean private (Steam also returns it for its own transient hiccups),
 * so a 500 is cross-checked against `getPlayerSummary`'s `visibility` before deciding: `visibility !== 3` (not
 * Public) confirms it really is a privacy issue and maps to `reason: 'private'`; `visibility === 3` (already
 * Public — so the 500 wasn't about privacy) or an unavailable summary (can't tell either way) maps to
 * `reason: 'transient'`, a distinct reason from a hard `'error'` so callers can tell the member this looked like
 * a passing Steam hiccup rather than sending them to check a privacy setting that isn't the problem. A 2xx with
 * no `playerstats.stats` (player doesn't own the game, or owns it but has never recorded a stat) maps to
 * `reason: 'no_game'`.
 */
export async function getGameStats(
  ctx: PluginContext,
  steamId: string,
  appId: number,
  options: GetGameStatsOptions = {},
): Promise<GetGameStatsResult> {
  const { bypassCache = false, keepKeys } = options;
  const cacheKey = redisKey('gamestats', 'steam', 'stats', String(appId), steamId);

  if (!bypassCache) {
    const cached = await ctx.redis.get(cacheKey);
    if (cached) {
      return { ok: true, stats: curateForCache(JSON.parse(cached) as Record<string, number>, keepKeys) };
    }
  }

  const apiKey = ctx.env.STEAM_API_KEY;
  if (!apiKey) return { ok: false, reason: 'error' };

  const params = new URLSearchParams({ key: apiKey, steamid: steamId, appid: String(appId) });
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/ISteamUserStats/GetUserStatsForGame/v2/?${params.toString()}`);
  } catch (err) {
    logRequestFailure(ctx, 'get stats request threw', { err: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: 'error' };
  }

  if (!res.ok) {
    if (res.status === 403) return { ok: false, reason: 'private' };
    if (res.status === 500) {
      const summary = await getPlayerSummary(ctx, steamId);
      if (summary && summary.visibility !== 3) return { ok: false, reason: 'private' };
      return { ok: false, reason: 'transient' };
    }
    logRequestFailure(ctx, 'get stats request failed', { status: res.status, appId });
    return { ok: false, reason: 'error' };
  }

  const json = (await res.json()) as UserStatsResponse;
  const rawStats = json.playerstats?.stats;
  if (!json.playerstats || !rawStats) return { ok: false, reason: 'no_game' };

  const stats: Record<string, number> = {};
  for (const s of rawStats) stats[s.name] = s.value;
  const curated = curateForCache(stats, keepKeys);

  await ctx.redis.set(cacheKey, JSON.stringify(curated), 'EX', STATS_CACHE_TTL_SECONDS);
  return { ok: true, stats: curated };
}
