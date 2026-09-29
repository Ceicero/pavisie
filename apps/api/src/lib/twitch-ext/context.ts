// Resolves a Twitch Extension request's `channel_id` (the JWT's `channelId` claim) down to the guild it's
// linked to, and whether that guild currently wants the Agis panel to work at all. Framework-light (only
// touches `app.prisma`/`app.configStore`, no route/reply concerns) so the actual routes stay thin.

import type { EconomyConfig } from '@pavisie/plugins/economy/manifest';
import type { ZodFastifyInstance } from '../http';

export interface TwitchExtGuildContext {
  guildId: string;
  economyConfig: EconomyConfig;
}

/**
 * `channel_id` -> `TwitchChatChannel` -> guild -> economy plugin enabled + `twitchEnabled`. Returns `null` for
 * every "not available" case (unlinked/disabled channel, economy plugin off, `twitchEnabled` off) rather than
 * throwing — the routes turn a `null` into `{ enabled: false }`, never an error, so the panel can show a plain
 * "not enabled for this channel" message instead of an error state (ARCHITECTURE.md §19d).
 *
 * `TwitchChatChannel.broadcasterUserId` is globally unique (one Pavisie chat-bot config per Twitch channel), so
 * this resolves at most one row. It may be a GUILDLESS row (`guildId` null — a streamer who set the channel up
 * from the creator dashboard, ARCHITECTURE.md §19e): the panel's currency is still guild-owned in this phase, so
 * a channel with no guild has nothing to show and resolves to `null` ("not enabled") like any other unavailable
 * case. Channel-owned currency (phase 2) lifts that.
 */
export async function resolveTwitchExtGuildContext(
  app: ZodFastifyInstance,
  channelId: string,
): Promise<TwitchExtGuildContext | null> {
  const channel = await app.prisma.twitchChatChannel.findFirst({
    where: { broadcasterUserId: channelId, enabled: true },
    // Deterministic if a broadcaster ever does end up linked to more than one guild: the oldest link wins.
    orderBy: { createdAt: 'asc' },
  });
  if (!channel) return null;

  const guildId = channel.guildId;
  if (!guildId) return null;

  const economyEnabled = await app.configStore.isEnabled(guildId, 'economy');
  if (!economyEnabled) return null;

  const economyConfig = await app.configStore.getConfig<EconomyConfig>(guildId, 'economy');
  if (!economyConfig.twitchEnabled) return null;

  return { guildId, economyConfig };
}
