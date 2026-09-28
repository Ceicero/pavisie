import { describe, expect, it } from 'vitest';
import { command as economyCommand } from '../commands/economy';
import { buildFakeEconomyPrisma, type FakeAccount } from './fake-economy-prisma';
import { GUILD_ID, buildCommandContext, descriptionOf, realT, titleOf } from './command-context';

const CONFIG = { currencyName: 'Coins', currencySymbol: '🪙' };

function acct(partial: Partial<FakeAccount> & Pick<FakeAccount, 'id' | 'platform' | 'userId' | 'balance'>): FakeAccount {
  return { guildId: GUILD_ID, lastDailyAt: null, ...partial };
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
  it('mixes DISCORD and TWITCH ordered by balance, escapes Twitch display names, falls back for missing ones', async () => {
    const { prisma } = buildFakeEconomyPrisma([
      acct({ id: 'd1', platform: 'DISCORD', userId: 'discord-user-1', balance: 30n }),
      acct({ id: 't1', platform: 'TWITCH', userId: 'twitch-1', displayName: 'My*Cool_Name', balance: 50n }),
      acct({ id: 't2', platform: 'TWITCH', userId: 'twitch-2', balance: 10n }),
    ]);

    const forGlobal = await runLeaderboard(prisma, 'global');
    const forDefault = await runLeaderboard(prisma); // no option = global default

    for (const reply of [forGlobal, forDefault]) {
      const desc = descriptionOf(reply);
      expect(titleOf(reply)).toBe(realT('leaderboardTitle'));
      // Ordered by balance desc: twitch-1 (50), discord-user-1 (30), twitch-2 (10).
      const idxTwitch1 = desc.indexOf('My\\*Cool\\_Name (Twitch)');
      const idxDiscord = desc.indexOf('<@discord-user-1>');
      const idxTwitch2 = desc.indexOf('Twitch viewer (Twitch)');
      expect(idxTwitch1).toBeGreaterThanOrEqual(0);
      expect(idxDiscord).toBeGreaterThan(idxTwitch1);
      expect(idxTwitch2).toBeGreaterThan(idxDiscord);
    }
  });
});

describe('/economy leaderboard — discord', () => {
  it('ranks by the sum of earned transaction types only, excluding give/admin and TWITCH rows', async () => {
    const { prisma, seedTransaction } = buildFakeEconomyPrisma([
      acct({ id: 'da', platform: 'DISCORD', userId: 'discord-a', balance: 0n }),
      acct({ id: 'db', platform: 'DISCORD', userId: 'discord-b', balance: 0n }),
      acct({ id: 'tc', platform: 'TWITCH', userId: 'twitch-c', balance: 0n }),
    ]);
    // discord-a: a big non-earned transfer plus a small earned daily.
    seedTransaction({ guildId: GUILD_ID, platform: 'DISCORD', accountId: 'da', fromUserId: 'discord-a', toUserId: 'someone', amount: 1000n, type: 'give' });
    seedTransaction({ guildId: GUILD_ID, platform: 'DISCORD', accountId: 'da', toUserId: 'discord-a', amount: 10n, type: 'daily' });
    // discord-b: a bigger earned daily.
    seedTransaction({ guildId: GUILD_ID, platform: 'DISCORD', accountId: 'db', toUserId: 'discord-b', amount: 500n, type: 'daily' });
    // twitch-c: a huge earned amount, but on TWITCH — must not appear on the discord board.
    seedTransaction({ guildId: GUILD_ID, platform: 'TWITCH', accountId: 'tc', toUserId: 'twitch-c', amount: 9999n, type: 'twitch_chat_earn' });

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
  it('ranks by twitch_chat_earn, excluding DISCORD rows', async () => {
    const { prisma, seedTransaction } = buildFakeEconomyPrisma([
      acct({ id: 'ta', platform: 'TWITCH', userId: 'twitch-a', displayName: 'Viewer A', balance: 0n }),
      acct({ id: 'tb', platform: 'TWITCH', userId: 'twitch-b', displayName: 'Viewer B', balance: 0n }),
      acct({ id: 'dd', platform: 'DISCORD', userId: 'discord-d', balance: 0n }),
    ]);
    seedTransaction({ guildId: GUILD_ID, platform: 'TWITCH', accountId: 'ta', toUserId: 'twitch-a', amount: 20n, type: 'twitch_chat_earn' });
    seedTransaction({ guildId: GUILD_ID, platform: 'TWITCH', accountId: 'tb', toUserId: 'twitch-b', amount: 200n, type: 'twitch_chat_earn' });
    seedTransaction({ guildId: GUILD_ID, platform: 'DISCORD', accountId: 'dd', toUserId: 'discord-d', amount: 9999n, type: 'daily' });

    const reply = await runLeaderboard(prisma, 'twitch');
    const desc = descriptionOf(reply);

    expect(titleOf(reply)).toBe(realT('leaderboardTwitchTitle', { platform: 'twitch' }));
    expect(desc).not.toContain('discord-d');
    const idxB = desc.indexOf('Viewer B (Twitch)');
    const idxA = desc.indexOf('Viewer A (Twitch)');
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThan(idxB);
  });
});

describe('/economy leaderboard — empty', () => {
  it('replies ephemerally without throwing for each mode when there are no rows', async () => {
    const { prisma } = buildFakeEconomyPrisma([]);

    for (const platform of ['global', 'discord', 'twitch'] as const) {
      const reply = await runLeaderboard(prisma, platform);
      expect(reply?.ephemeral).toBe(true);
      expect(descriptionOf(reply)).toBe('_Nothing to show._');
    }
  });
});

describe('/economy leaderboard — top 10 only', () => {
  it('shows at most the top 10 rows even with more accounts', async () => {
    const accounts = Array.from({ length: 12 }, (_, i) =>
      acct({ id: `acct-${i}`, platform: 'DISCORD' as const, userId: `user-${i}`, balance: BigInt(100 - i) }),
    );
    const { prisma } = buildFakeEconomyPrisma(accounts);

    const reply = await runLeaderboard(prisma, 'global');
    const desc = descriptionOf(reply);
    const lineCount = desc.split('\n').filter((l) => l.trim().length > 0).length;
    expect(lineCount).toBe(10);
    expect(desc).toContain('<@user-0>'); // highest balance (100) makes the cut
    expect(desc).not.toContain('<@user-11>'); // lowest balance (89) does not
  });
});
