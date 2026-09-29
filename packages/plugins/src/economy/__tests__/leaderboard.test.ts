import { describe, expect, it } from 'vitest';
import { command as economyCommand } from '../commands/economy';
import { buildFakeChannelPrisma } from '../../channel-economy/__tests__/fake-channel-prisma';
import { buildFakeEconomyPrisma, type FakeAccount } from './fake-economy-prisma';
import { GUILD_ID, buildCommandContext, descriptionOf, realT, titleOf } from './command-context';

const CONFIG = { currencyName: 'Coins', currencySymbol: '🪙' };

function acct(partial: Partial<FakeAccount> & Pick<FakeAccount, 'id' | 'platform' | 'userId' | 'balance'>): FakeAccount {
  return { guildId: GUILD_ID, lastDailyAt: null, ...partial };
}

interface LinkedChannel {
  broadcasterUserId: string;
  /** Defaults to this test guild; another value means "linked to a different server". */
  guildId?: string | null;
}

interface FakeEconomyRow {
  id: string;
  channelUserId: string;
  enabled?: boolean;
  currencySymbol?: string;
}

/**
 * The guild economy fake (Discord wallets) composed with the channel-economy fake (Twitch wallets owned by the
 * Twitch channel) plus the two lookups the leaderboard does to find a guild's LINKED channels' currencies:
 * `twitchChatChannel.findMany` (by guild) and `channelEconomy.findMany` (enabled + by broadcaster id).
 */
function buildPrisma(
  opts: {
    accounts?: FakeAccount[];
    channels?: LinkedChannel[];
    economies?: FakeEconomyRow[];
    wallets?: Parameters<typeof buildFakeChannelPrisma>[0];
  } = {},
) {
  const guild = buildFakeEconomyPrisma(opts.accounts ?? []);
  const channel = buildFakeChannelPrisma(opts.wallets ?? []);
  const economies = (opts.economies ?? []).map((e) => ({
    platform: 'TWITCH',
    enabled: true,
    currencyName: 'Agis',
    currencySymbol: '♦️',
    ...e,
  }));
  const channels = (opts.channels ?? []).map((ch) => ({ guildId: GUILD_ID, ...ch }));

  const prisma = {
    ...(guild.prisma as unknown as Record<string, unknown>),
    channelWallet: (channel.prisma as unknown as Record<string, unknown>).channelWallet,
    channelTransaction: (channel.prisma as unknown as Record<string, unknown>).channelTransaction,
    twitchChatChannel: {
      findMany: async ({ where }: { where: { guildId: string } }) =>
        channels.filter((ch) => ch.guildId === where.guildId).map((ch) => ({ broadcasterUserId: ch.broadcasterUserId })),
    },
    channelEconomy: {
      findMany: async ({
        where,
      }: {
        where: { platform: string; enabled: boolean; channelUserId: { in: string[] } };
      }) =>
        economies.filter(
          (e) => e.platform === where.platform && e.enabled === where.enabled && where.channelUserId.in.includes(e.channelUserId),
        ),
    },
  };
  return {
    prisma: prisma as unknown as Parameters<typeof buildCommandContext>[2],
    seedGuildTransaction: guild.seedTransaction,
    seedChannelTransaction: channel.seedTransaction,
    getWallet: channel.getWallet,
  };
}

function runLeaderboard(prisma: Parameters<typeof buildCommandContext>[2], platform?: 'global' | 'discord' | 'twitch') {
  const { c, reply } = buildCommandContext(
    { sub: 'leaderboard', strings: platform ? { platform } : {} },
    'caller-1',
    prisma,
    CONFIG,
  );
  return economyCommand.execute(c).then(() => reply());
}

describe('/economy leaderboard — global', () => {
  it("mixes this server's DISCORD wallets with its linked channel's Twitch wallets, ordered by balance, escaping Twitch names", async () => {
    const { prisma } = buildPrisma({
      accounts: [acct({ id: 'd1', platform: 'DISCORD', userId: 'discord-user-1', balance: 30n })],
      channels: [{ broadcasterUserId: 'b-1' }],
      economies: [{ id: 'econ-1', channelUserId: 'b-1', currencySymbol: '💎' }],
      wallets: [
        { economyId: 'econ-1', viewerUserId: 'twitch-1', displayName: 'My*Cool_Name', balance: 50n },
        { economyId: 'econ-1', viewerUserId: 'twitch-2', balance: 10n },
      ],
    });

    const forGlobal = await runLeaderboard(prisma, 'global');
    const forDefault = await runLeaderboard(prisma); // no option = global default

    for (const reply of [forGlobal, forDefault]) {
      const desc = descriptionOf(reply);
      expect(titleOf(reply)).toBe(realT('leaderboardTitle'));
      // Ordered by balance desc: twitch-1 (50), discord-user-1 (30), twitch-2 (10).
      const idxTwitch1 = desc.indexOf('My\\*Cool\\_Name (Twitch) — 50 💎');
      const idxDiscord = desc.indexOf('<@discord-user-1> — 30 🪙');
      const idxTwitch2 = desc.indexOf('Twitch viewer (Twitch) — 10 💎');
      expect(idxTwitch1).toBeGreaterThanOrEqual(0);
      expect(idxDiscord).toBeGreaterThan(idxTwitch1);
      expect(idxTwitch2).toBeGreaterThan(idxDiscord);
    }
  });

  it('leaves the old guild-scoped TWITCH rows out (the Twitch currency now lives on the channel)', async () => {
    const { prisma } = buildPrisma({
      accounts: [
        acct({ id: 'd1', platform: 'DISCORD', userId: 'discord-user-1', balance: 30n }),
        acct({ id: 'old', platform: 'TWITCH', userId: 'legacy-twitch', displayName: 'LegacyRow', balance: 9999n }),
      ],
    });
    const desc = descriptionOf(await runLeaderboard(prisma, 'global'));
    expect(desc).toContain('<@discord-user-1>');
    expect(desc).not.toContain('LegacyRow');
  });

  it('shows only the Discord wallets when no Twitch channel is linked to the server', async () => {
    const { prisma } = buildPrisma({
      accounts: [acct({ id: 'd1', platform: 'DISCORD', userId: 'discord-user-1', balance: 30n })],
      // A channel economy exists, but for a channel linked to ANOTHER server.
      channels: [{ broadcasterUserId: 'b-other', guildId: 'someone-elses-guild' }],
      economies: [{ id: 'econ-other', channelUserId: 'b-other' }],
      wallets: [{ economyId: 'econ-other', viewerUserId: 'stranger', displayName: 'Stranger', balance: 999n }],
    });
    const desc = descriptionOf(await runLeaderboard(prisma, 'global'));
    expect(desc).toContain('<@discord-user-1>');
    expect(desc).not.toContain('Stranger');
  });

  it("does not show a linked channel's wallets when the streamer has switched the currency off", async () => {
    const { prisma } = buildPrisma({
      channels: [{ broadcasterUserId: 'b-1' }],
      economies: [{ id: 'econ-1', channelUserId: 'b-1', enabled: false }],
      wallets: [{ economyId: 'econ-1', viewerUserId: 'v', displayName: 'HiddenViewer', balance: 500n }],
    });
    expect(descriptionOf(await runLeaderboard(prisma, 'global'))).toBe('_Nothing to show._');
  });
});

describe('/economy leaderboard — discord', () => {
  it('ranks by the sum of earned transaction types only, excluding give/admin and TWITCH rows', async () => {
    const { prisma, seedGuildTransaction } = buildPrisma({
      accounts: [
        acct({ id: 'da', platform: 'DISCORD', userId: 'discord-a', balance: 0n }),
        acct({ id: 'db', platform: 'DISCORD', userId: 'discord-b', balance: 0n }),
        acct({ id: 'tc', platform: 'TWITCH', userId: 'twitch-c', balance: 0n }),
      ],
    });
    // discord-a: a big non-earned transfer plus a small earned daily.
    seedGuildTransaction({ guildId: GUILD_ID, platform: 'DISCORD', accountId: 'da', fromUserId: 'discord-a', toUserId: 'someone', amount: 1000n, type: 'give' });
    seedGuildTransaction({ guildId: GUILD_ID, platform: 'DISCORD', accountId: 'da', toUserId: 'discord-a', amount: 10n, type: 'daily' });
    // discord-b: a bigger earned daily.
    seedGuildTransaction({ guildId: GUILD_ID, platform: 'DISCORD', accountId: 'db', toUserId: 'discord-b', amount: 500n, type: 'daily' });
    // twitch-c: a huge earned amount, but on TWITCH — must not appear on the discord board.
    seedGuildTransaction({ guildId: GUILD_ID, platform: 'TWITCH', accountId: 'tc', toUserId: 'twitch-c', amount: 9999n, type: 'twitch_chat_earn' });

    const reply = await runLeaderboard(prisma, 'discord');
    const desc = descriptionOf(reply);

    expect(titleOf(reply)).toBe(realT('leaderboardDiscordTitle', { platform: 'discord' }));
    expect(desc).not.toContain('twitch-c');
    expect(desc).not.toContain('1,000'); // the 'give' amount must not be summed in
    const idxB = desc.indexOf('<@discord-b>');
    const idxA = desc.indexOf('<@discord-a>');
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThan(idxB);
    expect(desc).toContain('500');
    expect(desc).toContain('10 ');
  });
});

describe('/economy leaderboard — twitch', () => {
  it("ranks the linked channel's viewers by lifetime earned, in that channel's own currency", async () => {
    const { prisma, seedChannelTransaction, getWallet } = buildPrisma({
      accounts: [acct({ id: 'dd', platform: 'DISCORD', userId: 'discord-d', balance: 0n })],
      channels: [{ broadcasterUserId: 'b-1' }],
      economies: [{ id: 'econ-1', channelUserId: 'b-1', currencySymbol: '💎' }],
      wallets: [
        { economyId: 'econ-1', viewerUserId: 'twitch-a', displayName: 'Viewer A' },
        { economyId: 'econ-1', viewerUserId: 'twitch-b', displayName: 'Viewer B' },
      ],
    });
    seedChannelTransaction({ economyId: 'econ-1', walletId: getWallet('econ-1', 'twitch-a')!.id, amount: 20n, type: 'twitch_chat_earn' });
    seedChannelTransaction({ economyId: 'econ-1', walletId: getWallet('econ-1', 'twitch-b')!.id, amount: 200n, type: 'twitch_chat_earn' });
    // A transfer is not "earned".
    seedChannelTransaction({ economyId: 'econ-1', walletId: getWallet('econ-1', 'twitch-a')!.id, amount: 9999n, type: 'give' });

    const reply = await runLeaderboard(prisma, 'twitch');
    const desc = descriptionOf(reply);

    expect(titleOf(reply)).toBe(realT('leaderboardTwitchTitle', { platform: 'twitch' }));
    expect(desc).not.toContain('discord-d');
    expect(desc).not.toContain('9,999');
    const idxB = desc.indexOf('Viewer B (Twitch) — 200 💎');
    const idxA = desc.indexOf('Viewer A (Twitch) — 20 💎');
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThan(idxB);
  });

  it('ignores the old guild-scoped TWITCH wallets and transactions', async () => {
    const { prisma, seedGuildTransaction } = buildPrisma({
      accounts: [acct({ id: 'old', platform: 'TWITCH', userId: 'legacy', displayName: 'LegacyRow', balance: 0n })],
      channels: [{ broadcasterUserId: 'b-1' }],
      economies: [{ id: 'econ-1', channelUserId: 'b-1' }],
    });
    seedGuildTransaction({ guildId: GUILD_ID, platform: 'TWITCH', accountId: 'old', toUserId: 'legacy', amount: 500n, type: 'twitch_chat_earn' });
    expect(descriptionOf(await runLeaderboard(prisma, 'twitch'))).toBe('_Nothing to show._');
  });

  it('merges several linked channels, each row keeping its own currency symbol', async () => {
    const { prisma, seedChannelTransaction, getWallet } = buildPrisma({
      channels: [{ broadcasterUserId: 'b-1' }, { broadcasterUserId: 'b-2' }],
      economies: [
        { id: 'econ-1', channelUserId: 'b-1', currencySymbol: '💎' },
        { id: 'econ-2', channelUserId: 'b-2', currencySymbol: '🔥' },
      ],
      wallets: [
        { economyId: 'econ-1', viewerUserId: 'a', displayName: 'Alice' },
        { economyId: 'econ-2', viewerUserId: 'b', displayName: 'Bob' },
      ],
    });
    seedChannelTransaction({ economyId: 'econ-1', walletId: getWallet('econ-1', 'a')!.id, amount: 10n, type: 'daily' });
    seedChannelTransaction({ economyId: 'econ-2', walletId: getWallet('econ-2', 'b')!.id, amount: 70n, type: 'daily' });

    const desc = descriptionOf(await runLeaderboard(prisma, 'twitch'));
    expect(desc.indexOf('Bob (Twitch) — 70 🔥')).toBeGreaterThanOrEqual(0);
    expect(desc.indexOf('Alice (Twitch) — 10 💎')).toBeGreaterThan(desc.indexOf('Bob (Twitch) — 70 🔥'));
  });

  it('shows an honest empty state (not an empty-looking board) when no channel is linked', async () => {
    const { prisma } = buildPrisma();
    const reply = await runLeaderboard(prisma, 'twitch');
    expect(reply?.ephemeral).toBe(true);
    expect(titleOf(reply)).toBe(realT('leaderboardTwitchTitle'));
    expect(descriptionOf(reply)).toBe(realT('leaderboardTwitchNone'));
  });

  it('shows the same honest empty state when a channel is linked but has no currency switched on', async () => {
    const { prisma } = buildPrisma({
      channels: [{ broadcasterUserId: 'b-1' }],
      economies: [{ id: 'econ-1', channelUserId: 'b-1', enabled: false }],
    });
    expect(descriptionOf(await runLeaderboard(prisma, 'twitch'))).toBe(realT('leaderboardTwitchNone'));
  });

  it('a linked channel with a currency but no earners yet shows "Nothing to show"', async () => {
    const { prisma } = buildPrisma({
      channels: [{ broadcasterUserId: 'b-1' }],
      economies: [{ id: 'econ-1', channelUserId: 'b-1' }],
    });
    expect(descriptionOf(await runLeaderboard(prisma, 'twitch'))).toBe('_Nothing to show._');
  });
});

describe('/economy leaderboard — empty', () => {
  it('replies ephemerally without throwing for each mode when there are no rows', async () => {
    const { prisma } = buildPrisma();

    for (const platform of ['global', 'discord'] as const) {
      const reply = await runLeaderboard(prisma, platform);
      expect(reply?.ephemeral).toBe(true);
      expect(descriptionOf(reply)).toBe('_Nothing to show._');
    }
    const twitch = await runLeaderboard(prisma, 'twitch');
    expect(twitch?.ephemeral).toBe(true);
    expect(descriptionOf(twitch)).toBe(realT('leaderboardTwitchNone'));
  });
});

describe('/economy leaderboard — top 10 only', () => {
  it('shows at most the top 10 rows even with more accounts', async () => {
    const accounts = Array.from({ length: 12 }, (_, i) =>
      acct({ id: `acct-${i}`, platform: 'DISCORD' as const, userId: `user-${i}`, balance: BigInt(100 - i) }),
    );
    const { prisma } = buildPrisma({ accounts });

    const reply = await runLeaderboard(prisma, 'global');
    const desc = descriptionOf(reply);
    const lineCount = desc.split('\n').filter((l) => l.trim().length > 0).length;
    expect(lineCount).toBe(10);
    expect(desc).toContain('<@user-0>'); // highest balance (100) makes the cut
    expect(desc).not.toContain('<@user-11>'); // lowest balance (89) does not
  });
});
