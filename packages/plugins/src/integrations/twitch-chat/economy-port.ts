// Adapter: one channel's `ChannelEconomy` row + the channel-economy ledger -> the `EconomyChatPort` the pure chat
// command handler (`economy-commands.ts`) talks to. The ledger is the only thing that writes a balance
// (ARCHITECTURE.md §18b); this file adds no business rules of its own — it just binds the channel's settings
// (daily/streak/give bounds) to the ledger calls.
import type { ChannelEconomy, PrismaClient } from '@pavisie/database';
import {
  claimChannelDaily,
  getChannelEarnedLeaderboard,
  getOrCreateChannelWallet,
  giveChannel,
} from '../../channel-economy/ledger';
import { pickChannelEconomySettings, toGiveConfig, toRollDailyConfig } from '../../channel-economy/settings';
import type { EconomyChatPort } from './economy-commands';

export function createEconomyChatPort(
  prisma: PrismaClient,
  economy: ChannelEconomy,
  botTwitchUserId: string | null,
): EconomyChatPort {
  const settings = pickChannelEconomySettings(economy);
  const walletKey = (viewerUserId: string) => ({ economyId: economy.id, viewerUserId });

  return {
    currencySymbol: economy.currencySymbol,

    async getOrCreateWallet(viewerUserId, displayName) {
      const wallet = await getOrCreateChannelWallet(prisma, walletKey(viewerUserId), displayName);
      return { balance: wallet.balance };
    },

    claimDaily(viewerUserId, displayName) {
      return claimChannelDaily(prisma, walletKey(viewerUserId), toRollDailyConfig(settings), new Date(), Math.random, displayName);
    },

    give(fromUserId, toUserId, amount, names) {
      return giveChannel(prisma, economy.id, fromUserId, toUserId, amount, toGiveConfig(settings), {
        botUserId: botTwitchUserId,
        fromDisplayName: names.fromDisplayName,
        toDisplayName: names.toDisplayName,
      });
    },

    async getLeaderboard(limit) {
      const rows = await getChannelEarnedLeaderboard(prisma, economy.id, limit);
      return rows.map((row) => ({ displayName: row.displayName ?? 'Twitch viewer', earned: row.earned }));
    },
  };
}
