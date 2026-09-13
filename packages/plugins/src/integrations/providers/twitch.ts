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
interface HelixEventSubCreateResponse {
  data: { id: string }[];
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

async function helixFetch<T>(ctx: PluginContext, path: string, token: string): Promise<T | null> {
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

async function lookupBroadcasterId(
  ctx: PluginContext,
  token: string,
  login: string,
): Promise<{ id: string; displayName: string } | null> {
  const result = await helixFetch<HelixUsersResponse>(
    ctx,
    `/users?login=${encodeURIComponent(login.toLowerCase())}`,
    token,
  );
  const user = result?.data[0];
  return user ? { id: user.id, displayName: user.display_name } : null;
}

/** Creates (idempotently — Twitch rejects an exact duplicate condition+type+callback with 409, treated as success)
 * the `stream.online` EventSub subscription for a connection's target, when webhook delivery is configured. */
export async function ensureTwitchEventSub(
  ctx: PluginContext,
  connection: IntegrationConnection,
): Promise<void> {
  const publicBase = ctx.env.PUBLIC_WEBHOOK_BASE_URL ?? ctx.env.API_BASE_URL;
  const secret = ctx.env.TWITCH_EVENTSUB_SECRET;
  if (!publicBase || !secret) return; // falls back to polling

  const token = await getTwitchAppToken(ctx);
  if (!token) return;

  const config = readAlertConfig(connection);
  const broadcaster = await lookupBroadcasterId(ctx, token, config.target);
  if (!broadcaster) {
    await markConnectionError(ctx, connection.id, `Twitch user "${config.target}" not found.`);
    return;
  }

  const clientId = ctx.env.TWITCH_CLIENT_ID;
  if (!clientId) return;

  const res = await fetch(`${HELIX_BASE}/eventsub/subscriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'stream.online',
      version: '1',
      condition: { broadcaster_user_id: broadcaster.id },
      transport: { method: 'webhook', callback: `${publicBase}/webhooks/twitch`, secret },
    }),
  });

  if (res.status === 202 || res.status === 201) {
    const json = (await res.json()) as HelixEventSubCreateResponse;
    const subId = json.data[0]?.id;
    if (subId) {
      await ctx.prisma.integrationConnection.update({
        where: { id: connection.id },
        data: {
          config: { ...(connection.config as Record<string, unknown>), eventSubId: subId },
          externalAccountId: broadcaster.id,
          externalAccountName: broadcaster.displayName,
        },
      });
    }
  } else if (res.status !== 409) {
    ctx.logger.warn({ status: res.status }, 'integrations/twitch: EventSub subscription create failed');
  }
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
  kind: 'oauth',
  requiredEnv: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'],
  pollIntervalSeconds: 120,
  configSchema: twitchConfigSchema,
  async poll(ctx, connection) {
    const usingEventSub = Boolean(
      (ctx.env.PUBLIC_WEBHOOK_BASE_URL ?? ctx.env.API_BASE_URL) && ctx.env.TWITCH_EVENTSUB_SECRET,
    );
    if (usingEventSub) {
      await ensureTwitchEventSub(ctx, connection);
      await markConnectionSynced(ctx, connection.id);
      return;
    }
    await pollStreamOnline(ctx, connection);
  },
  handleInbound: handleTwitchInbound,
};
