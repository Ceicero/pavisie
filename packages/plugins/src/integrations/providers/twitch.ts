import { z } from 'zod';
import type { IntegrationConnection } from '@pavisie/database';
import { redisKey } from '@pavisie/core';
import type { PluginContext } from '../../sdk';
import { formatTwitchStreamEmbed, type TwitchStream } from '../formatters/twitch';
import {
  claimAlertOnce,
  markConnectionError,
  markConnectionSynced,
  readAlertConfig,
  sendConnectionAlert,
} from './util';
import type { IntegrationProviderDef, InboundWebhookEvent } from './types';

const HELIX_BASE = 'https://api.twitch.tv/helix';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

export const twitchConfigSchema = z.object({
  target: z.string().trim().min(1).max(50), // Twitch login name (lowercase)
  channelId: z.string().regex(/^\d{17,20}$/),
  roleId: z
    .string()
    .regex(/^\d{17,20}$/)
    .nullable()
    .optional(),
  template: z.string().max(300).nullable().optional(),
  /** Twitch EventSub subscription id, once created — set by `ensureTwitchEventSub`. */
  eventSubId: z.string().nullable().optional(),
});

interface HelixTokenResponse {
  access_token: string;
  expires_in: number;
}
interface HelixUsersResponse {
  data: { id: string; login: string; display_name: string }[];
}
interface HelixStreamsResponse {
  data: TwitchStream[];
}

/** True when `config` is the shape the twitch-chat OAuth callback stamps onto a connection (`{ kind: 'chat' }`)
 * rather than an alert-watch connection created by `POST /:guildId/integrations/alerts`. Mirrors
 * `isChatKindConnection` in `apps/api/src/routes/integrations.ts` — the plugin package can't import from
 * `apps/api`, so this is a second, equally narrow copy of the same check. A chat-kind connection belongs
 * entirely to the Twitch chat-bot feature (`../twitch-chat/manager.ts`) and carries no `target`/`channelId`
 * alert config at all, so the alert poll must never touch it. */
export function isTwitchChatConnection(config: unknown): boolean {
  return Boolean(config && typeof config === 'object' && (config as Record<string, unknown>).kind === 'chat');
}

/** `getTwitchAppToken` only ever touches these three fields of `PluginContext` (env for the client
 * id/secret, redis to cache the token, logger to warn on failure) — narrowing the parameter to just that
 * slice, instead of requiring a full `PluginContext`, lets a caller with no discord.js client or bot-side
 * services (e.g. `apps/api`'s live-status route, ARCHITECTURE.md §10 — its `ZodFastifyInstance.log` is
 * already a real pino `Logger`, not just Fastify's narrower `FastifyBaseLogger`) reuse the client-credentials
 * flow without fabricating one. Every existing `PluginContext`-carrying caller already satisfies this
 * structurally. */
export type TwitchAppTokenContext = Pick<PluginContext, 'env' | 'redis' | 'logger'>;

/** Fetches (and Redis-caches) a Twitch app access token via the client-credentials grant. */
export async function getTwitchAppToken(ctx: TwitchAppTokenContext): Promise<string | null> {
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  const clientSecret = ctx.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const cacheKey = redisKey('integrations', 'twitch', 'apptoken');
  const cached = await ctx.redis.get(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });
  const res = await fetch(`${TOKEN_URL}?${params.toString()}`, { method: 'POST' });
  if (!res.ok) {
    ctx.logger.warn({ status: res.status }, 'integrations/twitch: failed to obtain app token');
    return null;
  }
  const json = (await res.json()) as HelixTokenResponse;
  await ctx.redis.set(cacheKey, json.access_token, 'EX', Math.max(60, json.expires_in - 60));
  return json.access_token;
}

async function helixFetch<T>(ctx: TwitchAppTokenContext, path: string, token: string): Promise<T | null> {
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  if (!clientId) return null;
  const res = await fetch(`${HELIX_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
  });
  if (!res.ok) {
    ctx.logger.warn({ status: res.status, path }, 'integrations/twitch: Helix request failed');
    return null;
  }
  return (await res.json()) as T;
}

/** Twitch logins are 1-25 characters of `a-z`, `0-9` and `_` (case-insensitive on input). */
const TWITCH_LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;
const TWITCH_URL_PATTERN = /^(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([A-Za-z0-9_]{1,25})\/?$/i;

/** Normalizes what a server admin typed into the "Twitch login" box — `Shroud`, `@shroud` or
 * `https://twitch.tv/shroud` — to the lowercase login, or `null` when it can't be a valid Twitch login. Alert
 * connections only ever store this normalized form, so the EventSub / inbound matching (always on the lowercased
 * login) can't miss because of a stray `@` or capital. */
export function normalizeTwitchLogin(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = TWITCH_URL_PATTERN.exec(trimmed)?.[1];
  const login = (fromUrl ?? trimmed.replace(/^@/, '')).toLowerCase();
  return TWITCH_LOGIN_PATTERN.test(login) ? login : null;
}

export type TwitchUserLookup =
  | { status: 'found'; id: string; login: string; displayName: string }
  /** Helix answered, and no such user exists (or it rejected the login as malformed). */
  | { status: 'not_found' }
  /** Could not ask (no credentials, app token unavailable, Helix 5xx/429, network). Says nothing about the user. */
  | { status: 'error' };

/** Looks one Twitch login up with the shared APP token (no one's Twitch sign-in involved). Distinguishes "that
 * user does not exist" from "Twitch could not be asked", so callers can refuse the first and tolerate the second. */
export async function lookupTwitchUser(ctx: TwitchAppTokenContext, login: string): Promise<TwitchUserLookup> {
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  if (!clientId) return { status: 'error' };
  try {
    const token = await getTwitchAppToken(ctx);
    if (!token) return { status: 'error' };
    const res = await fetch(`${HELIX_BASE}/users?login=${encodeURIComponent(login.toLowerCase())}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
    });
    if (res.status === 400) return { status: 'not_found' };
    if (!res.ok) {
      ctx.logger.warn({ status: res.status }, 'integrations/twitch: user lookup failed');
      return { status: 'error' };
    }
    const user = ((await res.json()) as HelixUsersResponse).data[0];
    return user
      ? { status: 'found', id: user.id, login: user.login, displayName: user.display_name }
      : { status: 'not_found' };
  } catch (err) {
    ctx.logger.warn({ err }, 'integrations/twitch: user lookup threw');
    return { status: 'error' };
  }
}

// ---------------------------------------------------------------------------------------------------------
// EventSub `stream.online` webhook subscriptions: create / replace / orphan cleanup.
//
// Twitch stores the callback URL ON the subscription, so a subscription created while the API lived at an old
// domain keeps posting there forever (and a revoked / failed one posts nowhere). `ensureTwitchEventSub` therefore
// never trusts "409 = already exists": it lists the app's subscriptions, keeps one that points at the current
// callback and is healthy, and deletes + recreates anything else. `cleanupOrphanedTwitchEventSubs` removes
// webhook subscriptions nobody watches any more. WebSocket-transport subscriptions (the chat bot's, see
// `../twitch-chat/`) are never touched by either path: everything here filters on `transport.method === 'webhook'`.
// ---------------------------------------------------------------------------------------------------------

interface HelixEventSubSubscription {
  id: string;
  status: string;
  type?: string;
  condition?: { broadcaster_user_id?: string };
  transport?: { method?: string; callback?: string };
}
interface HelixEventSubListResponse {
  data?: HelixEventSubSubscription[];
  pagination?: { cursor?: string };
}

/** Statuses a subscription may be in while still being (or about to be) a working one. `pending` is what a
 * subscription created a moment ago reports until Twitch's callback verification lands — replacing it would
 * thrash a perfectly good subscription. */
const USABLE_EVENTSUB_STATUSES: ReadonlySet<string> = new Set(['enabled', 'webhook_callback_verification_pending']);

/** The path of our receiver (`apps/api/src/routes/webhooks.ts` `POST /webhooks/twitch`), identical on every
 * domain the API serves — the cleanup only ever touches subscriptions that point at it, whatever the host. */
const TWITCH_CALLBACK_PATH = '/webhooks/twitch';
const SUBSCRIPTION_LIST_PAGE_LIMIT = 30; // x100 per page — far above the app's real subscription count.
const SUBSCRIPTION_CACHE_TTL_MS = 60_000; // under the 2-minute poll cadence: one list per poll run, shared by every connection.
const ORPHAN_DELETE_LIMIT_PER_RUN = 100;

let subscriptionCache: { clientId: string; at: number; subs: HelixEventSubSubscription[] } | null = null;
let helixRateLimitedUntil = 0;

/** Test hook: forget the cached subscription list and any rate-limit back-off. */
export function resetTwitchEventSubState(): void {
  subscriptionCache = null;
  helixRateLimitedUntil = 0;
}

export function twitchCallbackUrl(publicBase: string): string {
  return `${publicBase.replace(/\/+$/, '')}${TWITCH_CALLBACK_PATH}`;
}

function noteRateLimit(res: Response): void {
  if (res.status !== 429) return;
  const reset = Number(res.headers.get('ratelimit-reset'));
  helixRateLimitedUntil = Math.max(
    Date.now() + 5_000,
    Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 30_000,
  );
}

function helixBackedOff(): boolean {
  return Date.now() < helixRateLimitedUntil;
}

/** Lists every `stream.online` subscription the app owns (all pages), cached for a minute and updated in place by
 * the create/delete helpers below. `null` = the list could not be read (ensure then falls back to a plain create;
 * cleanup does nothing at all). */
async function listStreamOnlineSubscriptions(
  ctx: TwitchAppTokenContext,
  token: string,
  clientId: string,
  opts: { fresh?: boolean } = {},
): Promise<HelixEventSubSubscription[] | null> {
  if (
    !opts.fresh &&
    subscriptionCache &&
    subscriptionCache.clientId === clientId &&
    Date.now() - subscriptionCache.at < SUBSCRIPTION_CACHE_TTL_MS
  ) {
    return subscriptionCache.subs;
  }
  if (helixBackedOff()) return null;

  const subs: HelixEventSubSubscription[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < SUBSCRIPTION_LIST_PAGE_LIMIT; page++) {
    const query = new URLSearchParams({ type: 'stream.online', first: '100' });
    if (cursor) query.set('after', cursor);
    const res = await fetch(`${HELIX_BASE}/eventsub/subscriptions?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
    });
    if (!res.ok) {
      noteRateLimit(res);
      ctx.logger.warn({ status: res.status }, 'integrations/twitch: EventSub subscription list failed');
      return null;
    }
    const json = (await res.json()) as HelixEventSubListResponse;
    subs.push(...(json.data ?? []));
    cursor = json.pagination?.cursor;
    if (!cursor) break;
  }
  subscriptionCache = { clientId, at: Date.now(), subs };
  return subs;
}

/** Deletes one subscription (404 = already gone = success), keeping the cached list in step. */
async function deleteEventSubSubscription(
  ctx: TwitchAppTokenContext,
  token: string,
  clientId: string,
  subscriptionId: string,
): Promise<boolean> {
  if (helixBackedOff()) return false;
  const res = await fetch(`${HELIX_BASE}/eventsub/subscriptions?id=${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
  });
  if (res.status === 204 || res.status === 404) {
    if (subscriptionCache) subscriptionCache.subs = subscriptionCache.subs.filter((s) => s.id !== subscriptionId);
    return true;
  }
  noteRateLimit(res);
  ctx.logger.warn({ status: res.status }, 'integrations/twitch: EventSub subscription delete failed');
  return false;
}

export type EnsureTwitchEventSubResult =
  /** A working subscription for the broadcaster exists (found or created). */
  | 'subscribed'
  /** Nothing to do: webhook delivery unconfigured, no app token, or the connection has no target. */
  | 'skipped'
  /** Could not establish one (the connection may have been marked ERROR); try again next poll. */
  | 'failed';

/** Makes sure the connection's broadcaster has exactly one healthy `stream.online` webhook subscription that
 * points at the CURRENT callback (`${PUBLIC_WEBHOOK_BASE_URL}/webhooks/twitch`), when webhook delivery is
 * configured:
 * - lists the app's `stream.online` subscriptions (one cached list per poll run, `opts.fresh` to bypass it);
 * - a webhook subscription for the broadcaster with the right callback and a healthy status is kept as-is (its id
 *   is stored on the connection) — nothing is recreated;
 * - every other webhook subscription for that broadcaster (old callback domain, failed / revoked / over-failed
 *   status) is deleted, then a fresh one is created;
 * - a create answered with 409 (Twitch already has that exact subscription) counts as success. */
export async function ensureTwitchEventSub(
  ctx: PluginContext,
  connection: IntegrationConnection,
  opts: { fresh?: boolean } = {},
): Promise<EnsureTwitchEventSubResult> {
  const publicBase = ctx.env.PUBLIC_WEBHOOK_BASE_URL ?? ctx.env.API_BASE_URL;
  const secret = ctx.env.TWITCH_EVENTSUB_SECRET;
  if (!publicBase || !secret) return 'skipped'; // falls back to polling

  const token = await getTwitchAppToken(ctx);
  if (!token) return 'skipped';

  const config = readAlertConfig(connection);
  // No target configured is a config state, not a Twitch failure — mirrors `pollStreamOnline`'s own
  // `if (!config.target) return;` guard below. Bail before ever calling Helix (an empty `login` 400s).
  if (!config.target.trim()) return 'skipped';

  const clientId = ctx.env.TWITCH_CLIENT_ID;
  if (!clientId) return 'skipped';

  const lookup = await lookupTwitchUser(ctx, config.target);
  if (lookup.status === 'not_found') {
    await markConnectionError(ctx, connection.id, `Twitch user "${config.target}" not found.`);
    return 'failed';
  }
  if (lookup.status === 'error') return 'failed'; // Twitch could not be asked — says nothing about the user.
  const broadcaster = { id: lookup.id, displayName: lookup.displayName };

  const callback = twitchCallbackUrl(publicBase);
  const persist = async (subscriptionId: string): Promise<void> => {
    const stored = (connection.config as Record<string, unknown> | null) ?? {};
    if (
      stored.eventSubId === subscriptionId &&
      connection.externalAccountId === broadcaster.id &&
      connection.externalAccountName === broadcaster.displayName
    ) {
      return; // already recorded — no write on every poll
    }
    await ctx.prisma.integrationConnection.update({
      where: { id: connection.id },
      data: {
        config: { ...stored, eventSubId: subscriptionId },
        externalAccountId: broadcaster.id,
        externalAccountName: broadcaster.displayName,
      },
    });
  };

  const listed = await listStreamOnlineSubscriptions(ctx, token, clientId, opts);
  if (listed) {
    const mine = listed.filter(
      (s) => s.transport?.method === 'webhook' && s.condition?.broadcaster_user_id === broadcaster.id,
    );
    const good = mine.find((s) => s.transport?.callback === callback && USABLE_EVENTSUB_STATUSES.has(s.status));
    for (const stale of mine.filter((s) => s !== good)) {
      await deleteEventSubSubscription(ctx, token, clientId, stale.id);
    }
    if (good) {
      await persist(good.id);
      return 'subscribed';
    }
  }

  if (helixBackedOff()) return 'failed';
  const res = await fetch(`${HELIX_BASE}/eventsub/subscriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'stream.online',
      version: '1',
      condition: { broadcaster_user_id: broadcaster.id },
      transport: { method: 'webhook', callback, secret },
    }),
  });

  if (res.status === 202 || res.status === 201) {
    const json = (await res.json()) as { data: { id: string; status?: string }[] };
    const created = json.data[0];
    if (created?.id) {
      subscriptionCache?.subs.push({
        id: created.id,
        status: created.status ?? 'webhook_callback_verification_pending',
        type: 'stream.online',
        condition: { broadcaster_user_id: broadcaster.id },
        transport: { method: 'webhook', callback },
      });
      await persist(created.id);
    }
    return 'subscribed';
  }
  if (res.status === 409) return 'subscribed'; // Twitch already has this exact subscription (e.g. a stale cached list)

  noteRateLimit(res);
  ctx.logger.warn({ status: res.status }, 'integrations/twitch: EventSub subscription create failed');
  // A 4xx other than 429 means Twitch rejected the request itself (bad credentials, callback refused) — surface it
  // on the connection. 429/5xx are transient; the next poll retries without flipping the connection to ERROR.
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    await markConnectionError(
      ctx,
      connection.id,
      `Twitch rejected the stream alert subscription (status ${res.status}).`,
    );
  }
  return 'failed';
}

/** True for a connection that is a real, still-wanted Twitch alert: not soft-deleted or disconnected, not a
 * chat-kind row, and carrying a target. (Legacy generic-OAuth Twitch rows have `config: {}` — no target — and
 * never owned a stream.online subscription.) */
function isActiveTwitchAlert(connection: IntegrationConnection): boolean {
  return (
    connection.deletedAt === null &&
    connection.status !== 'DISCONNECTED' &&
    !isTwitchChatConnection(connection.config) &&
    readAlertConfig(connection).target.trim().length > 0
  );
}

export interface TwitchEventSubCleanupResult {
  /** `stream.online` webhook subscriptions (pointing at our receiver) inspected. */
  checked: number;
  deleted: number;
  /** Set when the run bailed out without deleting anything, and why. */
  skipped?: string;
}

/** Deletes `stream.online` WEBHOOK subscriptions (pointing at our `/webhooks/twitch` receiver, on any domain)
 * whose broadcaster has no active Twitch alert connection in any guild — e.g. left behind when an alert was
 * removed, or created under an old domain. Never touches WebSocket-transport subscriptions or any other type.
 * Fails safe: if the subscription list or the login -> id resolution can't be read, nothing is deleted. */
export async function cleanupOrphanedTwitchEventSubs(ctx: PluginContext): Promise<TwitchEventSubCleanupResult> {
  const clientId = ctx.env.TWITCH_CLIENT_ID;
  if (!clientId) return { checked: 0, deleted: 0, skipped: 'twitch not configured' };
  const token = await getTwitchAppToken(ctx);
  if (!token) return { checked: 0, deleted: 0, skipped: 'no app token' };

  const listed = await listStreamOnlineSubscriptions(ctx, token, clientId, { fresh: true });
  if (!listed) return { checked: 0, deleted: 0, skipped: 'subscription list unavailable' };

  const webhookSubs = listed.filter((s) => {
    if (s.transport?.method !== 'webhook') return false;
    try {
      return new URL(s.transport.callback ?? '').pathname.replace(/\/+$/, '') === TWITCH_CALLBACK_PATH;
    } catch {
      return false;
    }
  });
  if (webhookSubs.length === 0) return { checked: 0, deleted: 0 };

  const rows = await ctx.prisma.integrationConnection.findMany({
    where: { provider: 'TWITCH', deletedAt: null },
  });
  const active = rows.filter(isActiveTwitchAlert);
  const activeIds = new Set<string>();
  const unresolvedLogins = new Set<string>();
  for (const connection of active) {
    if (connection.externalAccountId) activeIds.add(connection.externalAccountId);
    else unresolvedLogins.add(readAlertConfig(connection).target.trim().toLowerCase());
  }

  // A connection that hasn't had its broadcaster id recorded yet (created, EventSub not set up / not recorded)
  // still counts as watching that broadcaster — resolve its login so its subscription isn't mistaken for an orphan.
  const logins = [...unresolvedLogins];
  for (let i = 0; i < logins.length; i += 100) {
    const query = logins
      .slice(i, i + 100)
      .map((login) => `login=${encodeURIComponent(login)}`)
      .join('&');
    const result = await helixFetch<HelixUsersResponse>(ctx, `/users?${query}`, token);
    if (!result) return { checked: webhookSubs.length, deleted: 0, skipped: 'login lookup failed' };
    for (const user of result.data) activeIds.add(user.id);
  }

  const orphans = webhookSubs
    .filter((s) => {
      const broadcasterId = s.condition?.broadcaster_user_id;
      return Boolean(broadcasterId) && !activeIds.has(broadcasterId as string);
    })
    .slice(0, ORPHAN_DELETE_LIMIT_PER_RUN);

  let deleted = 0;
  for (const orphan of orphans) {
    if (await deleteEventSubSubscription(ctx, token, clientId, orphan.id)) deleted += 1;
    else if (helixBackedOff()) break;
  }
  ctx.logger.info(
    { checked: webhookSubs.length, orphans: orphans.length, deleted },
    'integrations/twitch: orphaned stream.online webhook subscriptions cleaned up',
  );
  return { checked: webhookSubs.length, deleted };
}

async function pollStreamOnline(ctx: PluginContext, connection: IntegrationConnection): Promise<void> {
  const token = await getTwitchAppToken(ctx);
  if (!token) {
    await markConnectionError(ctx, connection.id, 'Twitch app credentials are not configured.');
    return;
  }

  const config = readAlertConfig(connection);
  if (!config.target) return;

  const result = await helixFetch<HelixStreamsResponse>(
    ctx,
    `/streams?user_login=${encodeURIComponent(config.target.toLowerCase())}`,
    token,
  );
  if (result === null) {
    await markConnectionError(ctx, connection.id, 'Twitch Helix request failed.');
    return;
  }

  const stream = result.data[0];
  if (stream) {
    const isNew = await claimAlertOnce(ctx, 'twitch', connection.id, stream.id);
    if (isNew) {
      const embed = formatTwitchStreamEmbed(stream, { template: config.template ?? undefined });
      await sendConnectionAlert(ctx, connection, embed);
    }
  }

  await markConnectionSynced(ctx, connection.id);
}

/** Handles a `stream.online` EventSub notification queued by `apps/api/src/routes/webhooks.ts` — the payload has
 * no guildId (Twitch's callback is a single shared endpoint), so every CONNECTED twitch connection whose target
 * matches the broadcaster login is alerted. */
async function handleTwitchInbound(
  ctx: PluginContext,
  _connection: IntegrationConnection | null,
  event: InboundWebhookEvent,
): Promise<void> {
  const payload = event.payload as {
    subscription?: { type?: string };
    event?: {
      id?: string;
      broadcaster_user_login?: string;
      broadcaster_user_name?: string;
      type?: string;
      started_at?: string;
    };
  };
  if (payload.subscription?.type !== 'stream.online' || !payload.event) return;

  const login = payload.event.broadcaster_user_login?.toLowerCase();
  if (!login) return;

  const connections = await ctx.prisma.integrationConnection.findMany({
    where: { provider: 'TWITCH', status: 'CONNECTED', deletedAt: null },
  });
  const matches = connections.filter((c) => readAlertConfig(c).target.toLowerCase() === login);

  for (const connection of matches) {
    const streamId = payload.event.id ?? `${login}:${payload.event.started_at ?? Date.now()}`;
    const isNew = await claimAlertOnce(ctx, 'twitch', connection.id, streamId);
    if (!isNew) continue;

    const config = readAlertConfig(connection);
    const stream: TwitchStream = {
      id: streamId,
      user_id: connection.externalAccountId ?? '',
      user_login: login,
      user_name: payload.event.broadcaster_user_name ?? login,
      started_at: payload.event.started_at,
    };
    const embed = formatTwitchStreamEmbed(stream, { template: config.template ?? undefined });
    await sendConnectionAlert(ctx, connection, embed);
    await markConnectionSynced(ctx, connection.id);
  }
}

export const twitchProvider: IntegrationProviderDef = {
  id: 'twitch',
  name: 'Twitch',
  // Alerts need no one's Twitch login: Helix user/stream lookups and the EventSub webhooks all use the app's own
  // client-credentials token. (The genuinely OAuth'd Twitch uses - the owner's bot identity and the creator
  // dashboard - live in apps/api, not behind this provider.) So it is set up like youtube/reddit: target + channel.
  kind: 'apikey',
  requiredEnv: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'],
  pollIntervalSeconds: 120,
  configSchema: twitchConfigSchema,
  async poll(ctx, connection) {
    // Chat-kind connections (see `isTwitchChatConnection`) share the same `provider: TWITCH` row shape that
    // `pollTwitchJob`'s query selects, but belong to the chat-bot feature and have no alert `target` at all.
    // Skip silently — this is not a poll failure to record, just the wrong provider logic seeing the wrong rows.
    if (isTwitchChatConnection(connection.config)) return;

    const usingEventSub = Boolean(
      (ctx.env.PUBLIC_WEBHOOK_BASE_URL ?? ctx.env.API_BASE_URL) && ctx.env.TWITCH_EVENTSUB_SECRET,
    );
    if (usingEventSub) {
      // `failed` leaves the connection as `ensureTwitchEventSub` left it (ERROR for a missing Twitch user) —
      // marking it synced here would immediately wipe that error again.
      const result = await ensureTwitchEventSub(ctx, connection);
      if (result !== 'failed') await markConnectionSynced(ctx, connection.id);
      return;
    }
    await pollStreamOnline(ctx, connection);
  },
  handleInbound: handleTwitchInbound,
};
