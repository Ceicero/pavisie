import { z } from 'zod';
import { redisKey } from '@pavisie/core';
import type { PluginContext } from '../../sdk';
import { formatRedditPostEmbed, isRedditPostNsfw, type RedditPost } from '../formatters/reddit';
import {
  claimAlertOnce,
  markConnectionError,
  markConnectionSynced,
  readAlertConfig,
  sendConnectionAlert,
} from './util';
import type { IntegrationProviderDef } from './types';

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';

export const redditConfigSchema = z.object({
  target: z
    .string()
    .trim()
    .min(1)
    .max(24)
    .transform((s) => s.replace(/^\/?r\//i, '')),
  channelId: z.string().regex(/^\d{17,20}$/),
  roleId: z
    .string()
    .regex(/^\d{17,20}$/)
    .nullable()
    .optional(),
  template: z.string().max(300).nullable().optional(),
  nsfwFilter: z.boolean().default(true),
});

interface RedditTokenResponse {
  access_token: string;
  expires_in: number;
}
interface RedditListingResponse {
  data: { children: { data: RedditPost & { over_18?: boolean; created_utc?: number } }[] };
}

async function getRedditAppToken(ctx: PluginContext): Promise<string | null> {
  const clientId = ctx.env.REDDIT_CLIENT_ID;
  const clientSecret = ctx.env.REDDIT_CLIENT_SECRET;
  const userAgent = ctx.env.REDDIT_USER_AGENT;
  if (!clientId || !clientSecret || !userAgent) return null;

  const cacheKey = redisKey('integrations', 'reddit', 'apptoken');
  const cached = await ctx.redis.get(cacheKey);
  if (cached) return cached;

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) {
    ctx.logger.warn({ status: res.status }, 'integrations/reddit: failed to obtain app token');
    return null;
  }
  const json = (await res.json()) as RedditTokenResponse;
  await ctx.redis.set(cacheKey, json.access_token, 'EX', Math.max(60, json.expires_in - 60));
  return json.access_token;
}

export const redditProvider: IntegrationProviderDef = {
  id: 'reddit',
  name: 'Reddit',
  kind: 'apikey',
  requiredEnv: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'],
  pollIntervalSeconds: 300,
  configSchema: redditConfigSchema,
  async poll(ctx, connection) {
    const token = await getRedditAppToken(ctx);
    const userAgent = ctx.env.REDDIT_USER_AGENT;
    if (!token || !userAgent) {
      await markConnectionError(ctx, connection.id, 'Reddit app credentials are not configured.');
      return;
    }

    const config = readAlertConfig(connection);
    if (!config.target) return;
    const raw = (connection.config as Record<string, unknown> | null) ?? {};
    const nsfwFilter = raw.nsfwFilter !== false;

    const res = await fetch(`${API_BASE}/r/${encodeURIComponent(config.target)}/new?limit=5`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent },
    });
    if (!res.ok) {
      await markConnectionError(ctx, connection.id, `Reddit request failed (${res.status}).`);
      return;
    }
    const json = (await res.json()) as RedditListingResponse;

    for (const child of [...json.data.children].reverse()) {
      const post = child.data;
      if (nsfwFilter && isRedditPostNsfw({ ...post, over18: post.over_18 })) continue;
      const isNew = await claimAlertOnce(ctx, 'reddit', connection.id, post.id);
      if (!isNew) continue;
      const embed = formatRedditPostEmbed(post, { template: config.template ?? undefined });
      await sendConnectionAlert(ctx, connection, embed);
    }

    await markConnectionSynced(ctx, connection.id);
  },
};
