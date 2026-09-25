// Discord <-> Twitch chat bridge — a tiny in-memory drop counter for the Discord -> Twitch relay direction. It
// exists specifically so the outbound rate limit (reusing `helix.ts`'s existing 1-send/sec/broadcaster
// `sendChatMessage` throttle) has a COUNTER to point to, never a content log — the dropped message's text is
// never recorded anywhere. Module-level singleton, same lifecycle convention as `helix.ts`'s
// `lastSentAtByBroadcaster` map and `engine.ts`'s cooldown maps: restart-safe-enough (resets to zero on a bot
// restart), not persisted, and never contains message content.
const dropCountByChannelId = new Map<string, number>();

/** Records one throttled/dropped Discord -> Twitch relay send for `channelId` (a `TwitchChatChannel.id`, not a
 * Discord channel id). Never pass the message text here — only the channel id. */
export function recordBridgeDrop(channelId: string): void {
  dropCountByChannelId.set(channelId, (dropCountByChannelId.get(channelId) ?? 0) + 1);
}

/** Current drop count for `channelId` (0 if none recorded). */
export function getBridgeDropCount(channelId: string): number {
  return dropCountByChannelId.get(channelId) ?? 0;
}

/** Drops `channelId`'s drop-count entry — called by `TwitchChatManager` whenever it stops tracking that
 * channel's bridge, so this module-level map doesn't grow forever across reconnects/unlinks. */
export function pruneBridgeDropCount(channelId: string): void {
  dropCountByChannelId.delete(channelId);
}
