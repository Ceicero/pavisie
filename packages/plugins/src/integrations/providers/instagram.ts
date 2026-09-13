import { z } from 'zod';
import { EMBED_LIMITS, truncate } from '@pavisie/core';
import { getValidAccessToken } from './oauth-tokens';
import { claimAlertOnce, markConnectionError, markConnectionSynced, sendConnectionAlert } from './util';
import type { IntegrationProviderDef } from './types';
import type { AlertEmbedData } from '../formatters/types';

const INSTAGRAM_PINK = 0xe4405f;
const MEDIA_FIELDS = 'id,caption,media_type,media_url,permalink,timestamp';

export const instagramConfigSchema = z.object({
  channelId: z.string().regex(/^\d{17,20}$/),
  roleId: z
    .string()
    .regex(/^\d{17,20}$/)
    .nullable()
    .optional(),
  template: z.string().max(300).nullable().optional(),
  /** ISO 8601 timestamp of the newest media item already alerted on — the "don't flood on first poll" watermark
   * (see `poll` below). Read/written only by the poller itself, never by the dashboard or a command. */
  lastSeenTimestamp: z.string().nullable().optional(),
  // Deliberately no `target`: unlike the alert-style providers (twitch/youtube/reddit/steam) and
  // google-calendar.ts's parity placeholder field, there is nothing to enter here at all — Instagram only
  // supports connecting and reading the authorized account's own media (Meta shut down arbitrary-username
  // lookups with the Basic Display API in Dec 2024). `readAlertConfig` (util.ts) already defaults a missing
  // `target` to `''`, so omitting the key costs nothing and avoids a phantom field a form might otherwise render.
});

interface InstagramMediaItem {
  id: string;
  caption?: string;
  media_type?: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  media_url?: string;
  permalink?: string;
  timestamp: string;
}

interface InstagramMediaResponse {
  data?: InstagramMediaItem[];
}

function mediaEmbed(item: InstagramMediaItem): AlertEmbedData {
  return {
    title: 'New Instagram post',
    url: item.permalink,
    description: item.caption ? truncate(item.caption, EMBED_LIMITS.description) : undefined,
    color: INSTAGRAM_PINK,
    // Video posts have no directly embeddable still image via this API — only IMAGE/CAROUSEL_ALBUM carry a
    // usable `media_url` (a video's `media_url` is the raw video file, not a thumbnail, so it's left off rather
    // than rendered as a broken image).
    imageUrl: item.media_type === 'IMAGE' || item.media_type === 'CAROUSEL_ALBUM' ? item.media_url : undefined,
    footer: 'Instagram',
  };
}

export const instagramProvider: IntegrationProviderDef = {
  id: 'instagram',
  name: 'Instagram',
  kind: 'oauth',
  requiredEnv: ['INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET'],
  pollIntervalSeconds: 900,
  configSchema: instagramConfigSchema,
  async poll(ctx, connection) {
    const accessToken = await getValidAccessToken(ctx, 'instagram', connection);
    if (!accessToken) {
      await markConnectionError(
        ctx,
        connection.id,
        'Instagram is not authorized (connect again from the dashboard).',
      );
      return;
    }

    const params = new URLSearchParams({ fields: MEDIA_FIELDS, access_token: accessToken });
    const res = await fetch(`https://graph.instagram.com/me/media?${params.toString()}`);
    if (!res.ok) {
      await markConnectionError(ctx, connection.id, `Instagram request failed (${res.status}).`);
      return;
    }
    const json = (await res.json()) as InstagramMediaResponse;
    const items = json.data ?? []; // newest first, per Instagram's documented default ordering

    const raw = (connection.config as Record<string, unknown> | null) ?? {};
    const lastSeen = typeof raw.lastSeenTimestamp === 'string' ? raw.lastSeenTimestamp : null;
    const lastSeenMs = lastSeen ? Date.parse(lastSeen) : null;

    // First-ever poll (no watermark yet): only establish the watermark below, alert on nothing. Without this
    // guard, an account with months of history would dump its entire back catalogue into the channel the moment
    // it's connected — `claimAlertOnce` alone doesn't prevent that, it only prevents *repeating* an alert.
    if (lastSeenMs !== null) {
      for (const item of [...items].reverse()) {
        if (Date.parse(item.timestamp) <= lastSeenMs) continue;
        const isNew = await claimAlertOnce(ctx, 'instagram', connection.id, item.id);
        if (!isNew) continue;
        await sendConnectionAlert(ctx, connection, mediaEmbed(item));
      }
    }

    const newest = items[0]?.timestamp ?? lastSeen;
    if (newest && newest !== lastSeen) {
      await ctx.prisma.integrationConnection.update({
        where: { id: connection.id },
        data: { config: { ...raw, lastSeenTimestamp: newest } },
      });
    }

    await markConnectionSynced(ctx, connection.id);
  },
};
