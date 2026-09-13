import type Redis from 'ioredis';
import { AppError, ExternalServiceError, env, redisKey } from '@pavisie/core';
import type { DiscordChannelOption, DiscordRoleOption } from '@pavisie/types';

const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_API_BASE = 'https://discord.com/api/v10';
const GUILDS_CACHE_TTL_SECONDS = 60;

/** Least-privilege OAuth scopes the dashboard login flow requests (ARCHITECTURE.md §10). */
export const OAUTH_SCOPES = 'identify guilds';

export interface DiscordTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export interface DiscordUserGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

/** Manage-permission bits (from Discord's permission bitfield) that grant dashboard access to a guild. */
const ADMINISTRATOR_BIT = 0x8n;
const MANAGE_GUILD_BIT = 0x20n;

/** True if a `/users/@me/guilds` entry's stringified permission bitfield includes Administrator or Manage Server. */
export function hasManageAccess(permissions: string, owner: boolean): boolean {
  if (owner) return true;
  let bits: bigint;
  try {
    bits = BigInt(permissions);
  } catch {
    return false;
  }
  return (bits & ADMINISTRATOR_BIT) === ADMINISTRATOR_BIT || (bits & MANAGE_GUILD_BIT) === MANAGE_GUILD_BIT;
}

function requireOAuthEnv(): { clientId: string; clientSecret: string; redirectUri: string } {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.DISCORD_OAUTH_REDIRECT_URI) {
    throw new ExternalServiceError('Discord OAuth is not configured.');
  }
  return {
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    redirectUri: env.DISCORD_OAUTH_REDIRECT_URI,
  };
}

/** Builds the Discord OAuth2 authorize URL with the given anti-CSRF `state`. */
export function buildAuthorizeUrl(state: string): string {
  const { clientId, redirectUri } = requireOAuthEnv();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    state,
    prompt: 'consent',
  });
  return `${DISCORD_AUTHORIZE_URL}?${params.toString()}`;
}

async function postForm(path: string, body: URLSearchParams): Promise<DiscordTokenResponse> {
  const res = await fetch(`${DISCORD_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new ExternalServiceError(`Discord OAuth request failed (${res.status}).`);
  }
  return (await res.json()) as DiscordTokenResponse;
}

/** Exchanges an OAuth `code` for an access/refresh token pair. */
export async function exchangeCode(code: string): Promise<DiscordTokenResponse> {
  const { clientId, clientSecret, redirectUri } = requireOAuthEnv();
  return postForm(
    '/oauth2/token',
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  );
}

/** Refreshes an expired/expiring access token. */
export async function refreshAccessToken(refreshToken: string): Promise<DiscordTokenResponse> {
  const { clientId, clientSecret } = requireOAuthEnv();
  return postForm(
    '/oauth2/token',
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
}

/** Fetches the authenticated user's identity (`identify` scope). */
export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new ExternalServiceError(`Failed to fetch Discord user (${res.status}).`);
  }
  return (await res.json()) as DiscordUser;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Discord caps `Retry-After` guidance we'll actually wait on — beyond this we'd rather fail fast than block the request. */
const MAX_RETRY_AFTER_WAIT_MS = 5000;

function requestUserGuilds(accessToken: string): Promise<Response> {
  return fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** Reads how long to back off from a 429: the JSON body's `retry_after` (seconds), else the `Retry-After` header, else 1s — capped at 5s. */
async function parseRetryAfterMs(res: Response): Promise<number> {
  let seconds: number | undefined;
  try {
    const body = (await res.json()) as { retry_after?: number };
    if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)) {
      seconds = body.retry_after;
    }
  } catch {
    // Body wasn't JSON (or already consumed) — fall through to the header/default below.
  }
  if (seconds === undefined) {
    const header = res.headers.get('retry-after');
    const parsed = header !== null ? Number(header) : NaN;
    seconds = Number.isFinite(parsed) ? parsed : 1;
  }
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_WAIT_MS);
}

/**
 * Fetches the authenticated user's guild list directly from Discord (`guilds` scope), bypassing the cache.
 * On a 429, waits out `retry_after` (capped at 5s) and retries exactly once before giving up.
 */
async function fetchDiscordUserGuildsUncached(accessToken: string): Promise<DiscordUserGuild[]> {
  const res = await requestUserGuilds(accessToken);
  if (res.status === 429) {
    await sleep(await parseRetryAfterMs(res));
    const retryRes = await requestUserGuilds(accessToken);
    if (!retryRes.ok) {
      throw new ExternalServiceError(`Failed to fetch Discord guild list (${retryRes.status}).`);
    }
    return (await retryRes.json()) as DiscordUserGuild[];
  }
  if (!res.ok) {
    throw new ExternalServiceError(`Failed to fetch Discord guild list (${res.status}).`);
  }
  return (await res.json()) as DiscordUserGuild[];
}

/**
 * In-process de-dup for concurrent `getCachedUserGuilds` calls on a cold cache: without this, a dashboard
 * page load that fires several requests at once (`/guilds`, `/guilds/:id`, `/guilds/:id/plugins`, ...) each
 * triggers its own Discord fetch, and Discord's per-user rate limit on `/users/@me/guilds` turns the losers
 * into 502s. Keyed by userId; always cleared in `finally` so a failed fetch doesn't wedge later calls.
 */
const inflightUserGuilds = new Map<string, Promise<DiscordUserGuild[]>>();

/** Fetches (and caches for 60s in Redis, per-user) the authenticated user's guild list. */
export async function getCachedUserGuilds(
  redis: Redis,
  userId: string,
  accessToken: string,
): Promise<DiscordUserGuild[]> {
  const cacheKey = redisKey('userguilds', userId);
  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as DiscordUserGuild[];
  }

  const inflight = inflightUserGuilds.get(userId);
  if (inflight) {
    return inflight;
  }

  const fetchPromise = (async () => {
    // Double-checked against Redis: cheap protection against a *different* process having just populated
    // the cache (a real distributed lock would be overkill for a 60s freshness cache).
    const recheck = await redis.get(cacheKey);
    if (recheck !== null) {
      return JSON.parse(recheck) as DiscordUserGuild[];
    }
    const guilds = await fetchDiscordUserGuildsUncached(accessToken);
    await redis.set(cacheKey, JSON.stringify(guilds), 'EX', GUILDS_CACHE_TTL_SECONDS);
    return guilds;
  })();

  inflightUserGuilds.set(userId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inflightUserGuilds.delete(userId);
  }
}

/** Invalidates a user's cached guild list (call after actions that change it, e.g. the bot joining a new guild). */
export async function invalidateCachedUserGuilds(redis: Redis, userId: string): Promise<void> {
  await redis.del(redisKey('userguilds', userId));
}

// ---------------------------------------------------------------------------
// Bot-token guild resources (channel/role pickers for the dashboard). These use the bot's own token — never
// the user's OAuth token, whose `identify guilds` scopes cannot read guild channels/roles — and are cached
// briefly per guild in Redis, mirroring the OAuth guild-list cache above. Dashboard settings pages mount
// several channel/role pickers at once, so a cold cache gets the same in-process de-dup and 429 retry
// treatment as `getCachedUserGuilds`.
// ---------------------------------------------------------------------------

const GUILD_RESOURCE_CACHE_TTL_SECONDS = 60;

/** Discord channel type ids (discord-api-types `ChannelType`) that the dashboard pickers can meaningfully target. */
const PICKABLE_CHANNEL_TYPES = new Set<number>([
  0, // GuildText
  2, // GuildVoice
  4, // GuildCategory
  5, // GuildAnnouncement
  13, // GuildStageVoice
  15, // GuildForum
  16, // GuildMedia
]);

/** Subset of Discord's guild channel object the pickers need. */
export interface DiscordGuildChannel {
  id: string;
  name: string;
  type: number;
  position: number;
  parent_id: string | null;
}

/** Subset of Discord's role object the pickers need. */
export interface DiscordGuildRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
}

/** True when the API has a bot token and can therefore read guild channels/roles on the dashboard's behalf. */
export function hasBotToken(): boolean {
  return Boolean(env.DISCORD_TOKEN);
}

function requestWithBotToken(path: string, token: string): Promise<Response> {
  return fetch(`${DISCORD_API_BASE}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
}

/**
 * Fetches a path with the bot token, bypassing the cache. On a 429, waits out `retry_after` (capped at 5s)
 * and retries exactly once before giving up — mirrors `fetchDiscordUserGuildsUncached`.
 */
async function fetchWithBotToken<T>(path: string): Promise<T> {
  if (!env.DISCORD_TOKEN) {
    throw new AppError(
      'bot_token_missing',
      'DISCORD_TOKEN is not configured for the API, so Discord channel/role lists are unavailable.',
      {
        status: 503,
        expose: true,
      },
    );
  }
  const token = env.DISCORD_TOKEN;
  const res = await requestWithBotToken(path, token);
  if (res.status === 429) {
    await sleep(await parseRetryAfterMs(res));
    const retryRes = await requestWithBotToken(path, token);
    if (!retryRes.ok) {
      throw new ExternalServiceError(`Discord API request failed (${retryRes.status}).`);
    }
    return (await retryRes.json()) as T;
  }
  if (!res.ok) {
    throw new ExternalServiceError(`Discord API request failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

/**
 * In-process de-dup for concurrent bot-token guild-resource fetches on a cold cache, shared by
 * `getCachedGuildChannels` and `getCachedGuildRoles` (see `inflightUserGuilds` above for the rationale).
 * Keyed by `${resource}:${guildId}` so the two resources never dedupe against each other. Always cleared
 * in `finally` so a failed fetch doesn't wedge later calls.
 */
const inflightGuildResources = new Map<string, Promise<unknown>>();

/**
 * Shared cache-check → in-flight-check → double-check → fetch → set flow for a bot-token guild resource.
 * `resource` is the Redis cache-key namespace (e.g. `'guildchannels'`) and also the in-flight map's
 * namespace. `load` fetches and transforms the raw Discord response into the shape that gets cached.
 */
async function getCachedGuildResource<T>(
  redis: Redis,
  resource: string,
  guildId: string,
  load: () => Promise<T>,
): Promise<T> {
  const cacheKey = redisKey(resource, guildId);
  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as T;
  }

  const inflightKey = `${resource}:${guildId}`;
  const inflight = inflightGuildResources.get(inflightKey);
  if (inflight) {
    return inflight as Promise<T>;
  }

  const fetchPromise = (async () => {
    // Double-checked against Redis: cheap protection against a *different* process having just populated
    // the cache (a real distributed lock would be overkill for a 60s freshness cache).
    const recheck = await redis.get(cacheKey);
    if (recheck !== null) {
      return JSON.parse(recheck) as T;
    }
    const value = await load();
    await redis.set(cacheKey, JSON.stringify(value), 'EX', GUILD_RESOURCE_CACHE_TTL_SECONDS);
    return value;
  })();

  inflightGuildResources.set(inflightKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inflightGuildResources.delete(inflightKey);
  }
}

/** Fetches (cached 60s per guild) the guild's pickable channels via the bot token, sorted by position. */
export async function getCachedGuildChannels(redis: Redis, guildId: string): Promise<DiscordChannelOption[]> {
  return getCachedGuildResource(redis, 'guildchannels', guildId, async () => {
    const raw = await fetchWithBotToken<DiscordGuildChannel[]>(`/guilds/${guildId}/channels`);
    return raw
      .filter((c) => PICKABLE_CHANNEL_TYPES.has(c.type))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((c) => ({ id: c.id, name: c.name, type: c.type }));
  });
}

/** Fetches (cached 60s per guild) the guild's assignable roles via the bot token (excludes `@everyone`), highest first. */
export async function getCachedGuildRoles(redis: Redis, guildId: string): Promise<DiscordRoleOption[]> {
  return getCachedGuildResource(redis, 'guildroles', guildId, async () => {
    const raw = await fetchWithBotToken<DiscordGuildRole[]>(`/guilds/${guildId}/roles`);
    return raw
      .filter((r) => r.id !== guildId) // `@everyone` shares the guild id and is never a picker target
      .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name))
      .map((r) => ({ id: r.id, name: r.name }));
  });
}

/** Builds a Discord CDN avatar URL, or `null` if the user has no custom avatar. */
export function buildAvatarUrl(userId: string, avatarHash: string | null): string | null {
  if (!avatarHash) return null;
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}`;
}

/**
 * Discord CDN icon URL for a guild's icon hash, or `null` if it has none — the animated-icon (`a_` prefix)
 * rule applies wherever a guild icon is rendered. Shared by `routes/guilds.ts` and `routes/owner-metrics.ts`
 * (ARCHITECTURE.md §10) so both surfaces render the same URL for the same icon hash.
 */
export function buildGuildIconUrl(guildId: string, iconHash: string | null | undefined): string | null {
  if (!iconHash) return null;
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.${iconHash.startsWith('a_') ? 'gif' : 'png'}`;
}
