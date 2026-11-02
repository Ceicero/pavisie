import { Client, Partials, type GatewayIntentBits } from 'discord.js';
import { statsRenameRateLimitFilter } from '@pavisie/plugins';

/**
 * Builds the single Discord gateway client for this process, with the partials needed for events on
 * uncached entities (DM channels, edited/deleted messages, reactions, members, users) to still fire.
 *
 * discord.js queues a rate-limited request and sleeps until the limit clears, which for a channel rename can be
 * ~10 minutes. `rejectOnRateLimit` is narrowed to the stats-channel renames (see `statsRenameRateLimitFilter`) so
 * those throw and get skipped instead, while every other request keeps the normal queueing.
 */
export function createClient(intents: GatewayIntentBits[]): Client {
  return new Client({
    intents,
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.GuildMember, Partials.User],
    rest: { rejectOnRateLimit: statsRenameRateLimitFilter },
  });
}
