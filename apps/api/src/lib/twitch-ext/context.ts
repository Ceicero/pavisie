// Resolves a Twitch Extension request's `channel_id` (the JWT's `channelId` claim) to the channel's OWN currency
// (`ChannelEconomy`) and whether the streamer currently wants the Agis panel to work at all. Framework-light (only
// touches `app.prisma`, no route/reply concerns) so the actual routes stay thin.

import type { ChannelEconomy } from '@pavisie/database';
import type { ZodFastifyInstance } from '../http';

export interface TwitchExtChannelContext {
  economy: ChannelEconomy;
}

/**
 * `channel_id` -> the channel's `ChannelEconomy` (platform TWITCH, `channelUserId` = the broadcaster id), enabled only.
 * Returns `null` for every "not available" case (no currency set up, or the streamer switched it off) rather than
 * throwing — the routes turn a `null` into `{ enabled: false }`, never an error, so the panel can show a plain "not
 * enabled for this channel" message instead of an error state (ARCHITECTURE.md §19d).
 *
 * The currency is owned by the Twitch channel (ARCHITECTURE.md §18b/§19e), so this needs NO Discord server, no linked
 * `TwitchChatChannel` and not even the chat bot to be connected: a streamer who only uses the creator dashboard and
 * the extension is fully supported.
 */
export async function resolveTwitchExtChannelContext(
  app: ZodFastifyInstance,
  channelId: string,
): Promise<TwitchExtChannelContext | null> {
  const economy = await app.prisma.channelEconomy.findUnique({
    where: { platform_channelUserId: { platform: 'TWITCH', channelUserId: channelId } },
  });
  if (!economy || !economy.enabled) return null;
  return { economy };
}
