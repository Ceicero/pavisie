import type { IntegrationConnection } from '@pavisie/database';
import { redisKey } from '@pavisie/core';
import { roleMention } from '../../sdk';
import type { PluginContext } from '../../sdk';
import { postAlert, type AlertTarget } from '../embeds';
import type { AlertEmbedData } from '../formatters/types';

const DEFAULT_DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 3; // 3 days — comfortably longer than any poll cadence.

/**
 * Records `itemId` as "already alerted" for `(provider, scope)`, returning `true` only the first time it's seen.
 * Backed by a Redis `SET` (SADD returns 1 only for a genuinely new member) with a rolling TTL refresh so the set
 * never grows unbounded.
 */
export async function claimAlertOnce(
  ctx: PluginContext,
  provider: string,
  scope: string,
  itemId: string,
  ttlSeconds = DEFAULT_DEDUPE_TTL_SECONDS,
): Promise<boolean> {
  const key = redisKey('integrations', 'dedupe', provider, scope);
  const added = await ctx.redis.sadd(key, itemId);
  await ctx.redis.expire(key, ttlSeconds);
  return added === 1;
}

/** Per-connection alert config shared by every alert-style provider (twitch/youtube/reddit/steam). */
export interface AlertConnectionConfig {
  target: string;
  channelId: string;
  roleId?: string | null;
  template?: string | null;
}

export function readAlertConfig(connection: IntegrationConnection): AlertConnectionConfig {
  const raw = (connection.config as Record<string, unknown> | null) ?? {};
  return {
    target: typeof raw.target === 'string' ? raw.target : '',
    channelId: typeof raw.channelId === 'string' ? raw.channelId : '',
    roleId: typeof raw.roleId === 'string' ? raw.roleId : null,
    template: typeof raw.template === 'string' ? raw.template : null,
  };
}

/** Sends an alert embed to the connection's configured channel (with an optional role mention), guild-scoped. */
export async function sendConnectionAlert(
  ctx: PluginContext,
  connection: IntegrationConnection,
  embed: AlertEmbedData,
): Promise<boolean> {
  const config = readAlertConfig(connection);
  if (!config.channelId) return false;
  const target: AlertTarget = {
    guildId: connection.guildId,
    channelId: config.channelId,
    roleId: config.roleId ?? undefined,
  };
  return postAlert(ctx, target, embed);
}

/** Marks a connection as having synced successfully just now, clearing any previous error. */
export async function markConnectionSynced(ctx: PluginContext, connectionId: string): Promise<void> {
  await ctx.prisma.integrationConnection.update({
    where: { id: connectionId },
    data: { lastSyncAt: new Date(), lastError: null, status: 'CONNECTED' },
  });
}

/** Marks a connection as errored (poll/inbound failure), truncating the message so it never blows up storage. */
export async function markConnectionError(
  ctx: PluginContext,
  connectionId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await ctx.prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { lastError: message.slice(0, 500), status: 'ERROR' },
    });
  } catch {
    // Connection may have been deleted mid-poll; nothing to update.
  }
}

export { roleMention };
