// A stateful Prisma fake for `/twitch-ext` route tests, covering exactly the models those routes (and the channel-economy
// ledger underneath them) touch: `ChannelEconomy` (the channel's own currency, looked up by broadcaster id),
// `ChannelWallet` and `ChannelTransaction` (including a real, directly-callable `$transaction`). The generic
// `createPrismaStub` (`@pavisie/plugins/sdk/testing`) that `buildTestApp` normally uses can't represent
// `prisma.$transaction(async (tx) => ...)` as a callable function (every property access returns a nested proxy, never
// something you can invoke) — same reason the plugins package has its own fake. The wallet/transaction half IS that
// package's fake (`channel-economy/__tests__/fake-channel-prisma.ts`), reused here rather than copied.
import { buildFakeChannelPrisma } from '@pavisie/plugins/channel-economy/__tests__/fake-channel-prisma';

export interface FakeChannelEconomy {
  id: string;
  /** The broadcaster's Twitch user id. */
  channelUserId: string;
  enabled: boolean;
  currencyName?: string;
  currencySymbol?: string;
  dailyMinAmount?: number;
  dailyMaxAmount?: number;
  streakBonusPerDay?: number;
  streakBonusMax?: number;
}

export interface FakeWalletSeed {
  economyId: string;
  viewerUserId: string;
  displayName?: string | null;
  balance?: bigint;
  lastDailyAt?: Date | null;
}

export interface FakeTransactionSeed {
  economyId: string;
  walletId: string | null;
  toUserId?: string | null;
  amount: bigint;
  type: string;
  note?: string | null;
}

export interface TwitchExtFakePrismaOptions {
  economies?: FakeChannelEconomy[];
  wallets?: FakeWalletSeed[];
  transactions?: FakeTransactionSeed[];
}

export function buildTwitchExtFakePrisma(options: TwitchExtFakePrismaOptions = {}) {
  const channel = buildFakeChannelPrisma(options.wallets ?? []);
  for (const t of options.transactions ?? []) channel.seedTransaction(t);

  const economies = (options.economies ?? []).map((e) => ({
    platform: 'TWITCH',
    currencyName: 'Agis',
    currencySymbol: '♦️',
    dailyMinAmount: 100,
    dailyMaxAmount: 100,
    streakBonusPerDay: 0,
    streakBonusMax: 0,
    giveMinAmount: 1,
    giveMaxAmount: 100000,
    earnEnabled: false,
    earnPerMessage: 5,
    earnCooldownSeconds: 60,
    earnDailyCap: 200,
    ...e,
  }));

  const channelEconomy = {
    findUnique: async ({
      where,
    }: {
      where: { platform_channelUserId: { platform: string; channelUserId: string } };
    }) => {
      const { platform, channelUserId } = where.platform_channelUserId;
      const found = economies.find((e) => e.platform === platform && e.channelUserId === channelUserId);
      return found ? { ...found } : null;
    },
  };

  const base = channel.prisma as unknown as Record<string, unknown>;
  const prisma = { ...base, channelEconomy };

  return {
    // Cast: a deliberately partial fake — only the models/methods `/twitch-ext` routes actually touch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma: prisma as any,
    getWallet: channel.getWallet,
    allWallets: channel.allWallets,
    getTransactions: channel.getTransactions,
  };
}
