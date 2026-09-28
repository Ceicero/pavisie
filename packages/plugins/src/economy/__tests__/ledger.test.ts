import { describe, expect, it } from 'vitest';
import { buildFakeEconomyPrisma } from './fake-economy-prisma';
import {
  adminAdjust,
  claimDaily,
  credit,
  getOrCreateWallet,
  give,
  type WalletKey,
} from '../ledger';
import { encodeStreakNote } from '../service';

const GUILD_ID = 'guild-1';

const DAILY_CONFIG = {
  dailyMinAmount: 50,
  dailyMaxAmount: 50,
  streakBonusPerDay: 0,
  streakBonusMax: 0,
};

const GIVE_CONFIG = { giveMinAmount: 1, giveMaxAmount: 1_000_000 };

function discordKey(userId: string): WalletKey {
  return { guildId: GUILD_ID, platform: 'DISCORD', userId };
}
function twitchKey(userId: string): WalletKey {
  return { guildId: GUILD_ID, platform: 'TWITCH', userId };
}

describe('ledger — wallets are isolated per platform', () => {
  it('credit on one platform leaves the other platform balance untouched, same guild+userId', async () => {
    const userId = 'user-1';
    const { prisma, getAccount } = buildFakeEconomyPrisma([
      { id: `acct-${GUILD_ID}-DISCORD-${userId}`, guildId: GUILD_ID, platform: 'DISCORD', userId, balance: 10n, lastDailyAt: null },
      { id: `acct-${GUILD_ID}-TWITCH-${userId}`, guildId: GUILD_ID, platform: 'TWITCH', userId, balance: 20n, lastDailyAt: null },
    ]);

    await credit(prisma, discordKey(userId), 5, 'twitch_chat_earn');

    expect(getAccount(`acct-${GUILD_ID}-DISCORD-${userId}`)?.balance).toBe(15n);
    expect(getAccount(`acct-${GUILD_ID}-TWITCH-${userId}`)?.balance).toBe(20n);
  });

  it('claiming daily on DISCORD then on TWITCH at the same `now` both succeed; a second DISCORD claim is on cooldown', async () => {
    const userId = 'user-2';
    const { prisma, getAccount } = buildFakeEconomyPrisma([
      { id: `acct-${GUILD_ID}-DISCORD-${userId}`, guildId: GUILD_ID, platform: 'DISCORD', userId, balance: 0n, lastDailyAt: null },
      { id: `acct-${GUILD_ID}-TWITCH-${userId}`, guildId: GUILD_ID, platform: 'TWITCH', userId, balance: 0n, lastDailyAt: null },
    ]);

    const now = new Date();
    const discordResult = await claimDaily(prisma, discordKey(userId), DAILY_CONFIG, now, () => 0);
    expect(discordResult.ok).toBe(true);

    const twitchResult = await claimDaily(prisma, twitchKey(userId), DAILY_CONFIG, now, () => 0);
    expect(twitchResult.ok).toBe(true);

    expect(getAccount(`acct-${GUILD_ID}-DISCORD-${userId}`)?.balance).toBe(50n);
    expect(getAccount(`acct-${GUILD_ID}-TWITCH-${userId}`)?.balance).toBe(50n);
    // Twitch claim must not have touched the Discord wallet's lastDailyAt.
    expect(getAccount(`acct-${GUILD_ID}-DISCORD-${userId}`)?.lastDailyAt?.getTime()).toBe(now.getTime());

    const secondDiscordResult = await claimDaily(prisma, discordKey(userId), DAILY_CONFIG, now, () => 0);
    expect(secondDiscordResult.ok).toBe(false);
  });

  it('the streak is read per platform: a DISCORD daily tx with streak 5 does not affect the TWITCH streak', async () => {
    const userId = 'user-3';
    const discordAcctId = `acct-${GUILD_ID}-DISCORD-${userId}`;
    const twitchAcctId = `acct-${GUILD_ID}-TWITCH-${userId}`;
    const lastClaim = new Date(Date.now() - 21 * 60 * 60 * 1000); // 21h ago — outside the 20h cooldown
    const { prisma, seedTransaction } = buildFakeEconomyPrisma([
      { id: discordAcctId, guildId: GUILD_ID, platform: 'DISCORD', userId, balance: 0n, lastDailyAt: lastClaim },
      { id: twitchAcctId, guildId: GUILD_ID, platform: 'TWITCH', userId, balance: 0n, lastDailyAt: lastClaim },
    ]);
    seedTransaction({
      guildId: GUILD_ID,
      platform: 'DISCORD',
      accountId: discordAcctId,
      toUserId: userId,
      amount: 50n,
      type: 'daily',
      note: encodeStreakNote(5),
    });
    // No TWITCH daily transaction seeded — its streak should read as 0 (fresh), not 5.

    const now = new Date();
    const twitchResult = await claimDaily(prisma, twitchKey(userId), DAILY_CONFIG, now, () => 0);
    expect(twitchResult.ok).toBe(true);
    if (twitchResult.ok) {
      expect(twitchResult.streak).toBe(1);
    }

    const discordResult = await claimDaily(prisma, discordKey(userId), DAILY_CONFIG, now, () => 0);
    expect(discordResult.ok).toBe(true);
    if (discordResult.ok) {
      expect(discordResult.streak).toBe(6);
    }
  });
});

describe('ledger — give', () => {
  it('rejects a cross-platform transfer and creates no wallet, no transaction, no balance change', async () => {
    const senderId = 'sender-1';
    const targetId = 'target-1';
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: `acct-${GUILD_ID}-DISCORD-${senderId}`, guildId: GUILD_ID, platform: 'DISCORD', userId: senderId, balance: 100n, lastDailyAt: null },
    ]);

    const result = await give(prisma, discordKey(senderId), twitchKey(targetId), 10, GIVE_CONFIG);

    expect(result).toEqual({ ok: false, reason: 'cross_platform' });
    expect(getAccount(`acct-${GUILD_ID}-DISCORD-${senderId}`)?.balance).toBe(100n);
    expect(getAccount(`acct-${GUILD_ID}-TWITCH-${targetId}`)).toBeUndefined();
    expect(getTransactions()).toHaveLength(0);
  });

  it('moves the balance and writes exactly one give transaction on the same platform', async () => {
    const senderId = 'sender-2';
    const targetId = 'target-2';
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: `acct-${GUILD_ID}-TWITCH-${senderId}`, guildId: GUILD_ID, platform: 'TWITCH', userId: senderId, balance: 100n, lastDailyAt: null },
      { id: `acct-${GUILD_ID}-TWITCH-${targetId}`, guildId: GUILD_ID, platform: 'TWITCH', userId: targetId, balance: 0n, lastDailyAt: null },
    ]);

    const result = await give(prisma, twitchKey(senderId), twitchKey(targetId), 40, GIVE_CONFIG);

    expect(result).toEqual({ ok: true });
    expect(getAccount(`acct-${GUILD_ID}-TWITCH-${senderId}`)?.balance).toBe(60n);
    expect(getAccount(`acct-${GUILD_ID}-TWITCH-${targetId}`)?.balance).toBe(40n);
    const giveRows = getTransactions().filter((t) => t.type === 'give');
    expect(giveRows).toHaveLength(1);
    expect(giveRows[0]).toMatchObject({ platform: 'TWITCH', fromUserId: senderId, toUserId: targetId, amount: 40n });
  });
});

describe('ledger — credit', () => {
  it('rejects 0, negative and non-integer amounts with invalid_amount, writing nothing', async () => {
    const userId = 'user-4';
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: `acct-${GUILD_ID}-TWITCH-${userId}`, guildId: GUILD_ID, platform: 'TWITCH', userId, balance: 10n, lastDailyAt: null },
    ]);

    const zero = await credit(prisma, twitchKey(userId), 0, 'twitch_chat_earn');
    const negative = await credit(prisma, twitchKey(userId), -5, 'twitch_chat_earn');
    const fractional = await credit(prisma, twitchKey(userId), 1.5, 'twitch_chat_earn');

    expect(zero).toEqual({ ok: false, reason: 'invalid_amount' });
    expect(negative).toEqual({ ok: false, reason: 'invalid_amount' });
    expect(fractional).toEqual({ ok: false, reason: 'invalid_amount' });
    expect(getAccount(`acct-${GUILD_ID}-TWITCH-${userId}`)?.balance).toBe(10n);
    expect(getTransactions()).toHaveLength(0);
  });

  it('a valid credit on TWITCH writes exactly one transaction with platform/type/note and returns the new balance', async () => {
    const userId = 'user-5';
    const { prisma, getTransactions } = buildFakeEconomyPrisma([
      { id: `acct-${GUILD_ID}-TWITCH-${userId}`, guildId: GUILD_ID, platform: 'TWITCH', userId, balance: 10n, lastDailyAt: null },
    ]);

    const result = await credit(prisma, twitchKey(userId), 15, 'twitch_watch_earn', 'watched 30 min');

    expect(result).toEqual({ ok: true, newBalance: 25n });
    const rows = getTransactions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      platform: 'TWITCH',
      type: 'twitch_watch_earn',
      note: 'watched 30 min',
      amount: 15n,
      toUserId: userId,
    });
  });
});

describe('ledger — adminAdjust', () => {
  it('a remove larger than the balance returns would_go_negative, leaves balance unchanged, writes no transaction', async () => {
    const userId = 'user-6';
    const acctId = `acct-${GUILD_ID}-DISCORD-${userId}`;
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: acctId, guildId: GUILD_ID, platform: 'DISCORD', userId, balance: 30n, lastDailyAt: null },
    ]);

    const result = await adminAdjust(prisma, discordKey(userId), -1, 50);

    expect(result).toEqual({ ok: false, reason: 'would_go_negative' });
    expect(getAccount(acctId)?.balance).toBe(30n);
    expect(getTransactions()).toHaveLength(0);
  });

  it('a valid add sets platform and type admin_add', async () => {
    const userId = 'user-7';
    const acctId = `acct-${GUILD_ID}-DISCORD-${userId}`;
    const { prisma, getTransactions } = buildFakeEconomyPrisma([
      { id: acctId, guildId: GUILD_ID, platform: 'DISCORD', userId, balance: 0n, lastDailyAt: null },
    ]);

    const result = await adminAdjust(prisma, discordKey(userId), 1, 25, 'gift');

    expect(result).toEqual({ ok: true, newBalance: 25n });
    const rows = getTransactions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: 'DISCORD', type: 'admin_add', toUserId: userId, amount: 25n, note: 'gift' });
  });

  it('a valid remove sets platform and type admin_remove', async () => {
    const userId = 'user-8';
    const acctId = `acct-${GUILD_ID}-DISCORD-${userId}`;
    const { prisma, getTransactions } = buildFakeEconomyPrisma([
      { id: acctId, guildId: GUILD_ID, platform: 'DISCORD', userId, balance: 50n, lastDailyAt: null },
    ]);

    const result = await adminAdjust(prisma, discordKey(userId), -1, 20, 'penalty');

    expect(result).toEqual({ ok: true, newBalance: 30n });
    const rows = getTransactions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: 'DISCORD', type: 'admin_remove', fromUserId: userId, amount: 20n, note: 'penalty' });
  });
});

describe('ledger — getOrCreateWallet', () => {
  it('stores a TWITCH displayName and updates it on a later call', async () => {
    const userId = 'user-9';
    const { prisma, getAccount } = buildFakeEconomyPrisma([]);

    await getOrCreateWallet(prisma, twitchKey(userId), 'OldName');
    expect(getAccount(`acct-${GUILD_ID}-TWITCH-${userId}`)?.displayName).toBe('OldName');

    await getOrCreateWallet(prisma, twitchKey(userId), 'NewName');
    expect(getAccount(`acct-${GUILD_ID}-TWITCH-${userId}`)?.displayName).toBe('NewName');
  });

  it('calling without a displayName does not wipe an existing one', async () => {
    const userId = 'user-10';
    const { prisma, getAccount } = buildFakeEconomyPrisma([
      { id: `acct-${GUILD_ID}-TWITCH-${userId}`, guildId: GUILD_ID, platform: 'TWITCH', userId, displayName: 'KeepMe', balance: 0n, lastDailyAt: null },
    ]);

    await getOrCreateWallet(prisma, twitchKey(userId));

    expect(getAccount(`acct-${GUILD_ID}-TWITCH-${userId}`)?.displayName).toBe('KeepMe');
  });
});

describe('ledger — concurrency', () => {
  it('20 concurrent credit(5) calls on the same TWITCH wallet: final balance 100, exactly 20 transactions, all platform TWITCH', async () => {
    const userId = 'user-11';
    const acctId = `acct-${GUILD_ID}-TWITCH-${userId}`;
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: acctId, guildId: GUILD_ID, platform: 'TWITCH', userId, balance: 0n, lastDailyAt: null },
    ]);

    const N = 20;
    await Promise.all(
      Array.from({ length: N }, () => credit(prisma, twitchKey(userId), 5, 'twitch_chat_earn')),
    );

    expect(getAccount(acctId)?.balance).toBe(100n);
    const rows = getTransactions();
    expect(rows).toHaveLength(N);
    expect(rows.every((r) => r.platform === 'TWITCH')).toBe(true);
  });
});
