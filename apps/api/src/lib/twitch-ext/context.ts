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
 * `TwitchChatChannel.broadcasterUserId` has no *global* unique constraint in the schema (only
 * `@@unique([guildId, broadcasterUserId])`) — but ARCHITECTURE.md §18b/§19a's identity model is that a given
 * Twitch broadcaster only ever links one guild in practice, so `findFirst` (rather than requiring a guildId we
 * don't have yet) is the right lookup here, same as any other channel_id -> guild resolution in this codebase.
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

  const economyEnabled = await app.configStore.isEnabled(channel.guildId, 'economy');
  if (!economyEnabled) return null;

  const economyConfig = await app.configStore.getConfig<EconomyConfig>(channel.guildId, 'economy');
  if (!economyConfig.twitchEnabled) return null;

  return { guildId: channel.guildId, economyConfig };
}
