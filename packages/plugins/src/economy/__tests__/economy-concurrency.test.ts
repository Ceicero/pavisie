import { describe, expect, it, vi } from 'vitest';
import { command as economyCommand } from '../commands/economy';
import { DAILY_COOLDOWN_MS } from '../service';
import { buildFakeEconomyPrisma } from './fake-economy-prisma';
import { GUILD_ID, buildCommandContext, descriptionOf, errorText } from './command-context';

const GIVE_CONFIG = { currencyName: 'Coins', currencySymbol: '🪙', giveMinAmount: 1, giveMaxAmount: 1_000_000 };
const DAILY_CONFIG = {
  currencyName: 'Coins',
  currencySymbol: '🪙',
  dailyMinAmount: 50,
  dailyMaxAmount: 50,
  streakBonusPerDay: 0,
  streakBonusMax: 0,
};

describe('/economy give — concurrent overdraw guard (BUG 1)', () => {
  it('two concurrent gives for the full balance: exactly one succeeds, no ledger row for the loser, balance never goes negative', async () => {
    const senderId = 'sender-1';
    const targetId = 'target-1';
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: `acct-${GUILD_ID}-DISCORD-${senderId}`, guildId: GUILD_ID, platform: 'DISCORD', userId: senderId, balance: 100n, lastDailyAt: null },
      { id: `acct-${GUILD_ID}-DISCORD-${targetId}`, guildId: GUILD_ID, platform: 'DISCORD', userId: targetId, balance: 0n, lastDailyAt: null },
    ]);

    const makeCtx = () =>
      buildCommandContext(
        { sub: 'give', integers: { amount: 100 }, users: { user: { id: targetId, username: 'target' } } },
        senderId,
        prisma,
        GIVE_CONFIG,
      );

    const first = makeCtx();
    const second = makeCtx();

    await Promise.all([economyCommand.execute(first.c), economyCommand.execute(second.c)]);

    const replies = [first.reply(), second.reply()];
    const succeeded = replies.filter((r) => descriptionOf(r).includes('You gave'));
    const rejected = replies.filter((r) => descriptionOf(r) === errorText('give.insufficient_balance'));
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Balance moved by exactly one give, never negative.
    expect(getAccount(`acct-${GUILD_ID}-DISCORD-${senderId}`)?.balance).toBe(0n);
    expect(getAccount(`acct-${GUILD_ID}-DISCORD-${targetId}`)?.balance).toBe(100n);

    // Exactly one ledger row — the rejected call wrote none.
    const giveRows = getTransactions().filter((t) => t.type === 'give');
    expect(giveRows).toHaveLength(1);
    expect(giveRows[0]).toMatchObject({ fromUserId: senderId, toUserId: targetId, amount: 100n });
  });

  it('a give that would overdraw against the true (post-race) balance is rejected and writes no ledger row', async () => {
    const senderId = 'sender-2';
    const targetId = 'target-2';
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: `acct-${GUILD_ID}-DISCORD-${senderId}`, guildId: GUILD_ID, platform: 'DISCORD', userId: senderId, balance: 50n, lastDailyAt: null },
      { id: `acct-${GUILD_ID}-DISCORD-${targetId}`, guildId: GUILD_ID, platform: 'DISCORD', userId: targetId, balance: 0n, lastDailyAt: null },
    ]);

    // Both calls pass `validateGive`'s pre-check (each give of 50 <= the balance of 50 read at the top of the
    // handler), but only one can actually be honored once the transaction re-checks the real balance.
    const makeCtx = () =>
      buildCommandContext(
        { sub: 'give', integers: { amount: 50 }, users: { user: { id: targetId, username: 'target' } } },
        senderId,
        prisma,
        GIVE_CONFIG,
      );
    const first = makeCtx();
    const second = makeCtx();

    await Promise.all([economyCommand.execute(first.c), economyCommand.execute(second.c)]);

    expect(getAccount(`acct-${GUILD_ID}-DISCORD-${senderId}`)?.balance).toBe(0n);
    expect(getTransactions().filter((t) => t.type === 'give')).toHaveLength(1);
    const rejectedCount = [first.reply(), second.reply()].filter(
      (r) => descriptionOf(r) === errorText('give.insufficient_balance'),
    ).length;
    expect(rejectedCount).toBe(1);
  });
});

describe('/economy admin add/remove — increment-based writes (BUG 2)', () => {
  it('two sequential admin adds each move the balance by the full amount', async () => {
    const targetId = 'member-1';
    const acctId = `acct-${GUILD_ID}-${targetId}`;
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: acctId, guildId: GUILD_ID, platform: 'DISCORD', userId: targetId, balance: 0n, lastDailyAt: null },
    ]);

    const audit = vi.fn(async (_entry: unknown) => undefined);
    const first = buildCommandContext(
      { group: 'admin', sub: 'add', integers: { amount: 100 }, users: { user: { id: targetId, username: 'member' } } },
      'admin-1',
      prisma,
      GIVE_CONFIG,
      { staffLevel: 'moderator', audit },
    );
    await economyCommand.execute(first.c);
    expect(getAccount(acctId)?.balance).toBe(100n);
    expect(audit.mock.calls[0]![0]).toMatchObject({ after: { balance: '100', amount: 100 } });

    const second = buildCommandContext(
      { group: 'admin', sub: 'add', integers: { amount: 100 }, users: { user: { id: targetId, username: 'member' } } },
      'admin-1',
      prisma,
      GIVE_CONFIG,
      { staffLevel: 'moderator', audit },
    );
    await economyCommand.execute(second.c);

    // Each add moved the balance by the full 100 — not halved, not dropped by an absolute-set race.
    expect(getAccount(acctId)?.balance).toBe(200n);
    expect(audit.mock.calls[1]![0]).toMatchObject({ after: { balance: '200', amount: 100 } });

    const addRows = getTransactions().filter((t) => t.type === 'admin_add');
    expect(addRows).toHaveLength(2);
    expect(addRows.map((r) => r.amount)).toEqual([100n, 100n]);
  });

  it('two concurrent admin removes where only one can be honored: the loser is rejected with no ledger row and the balance never goes negative', async () => {
    const targetId = 'member-2';
    const acctId = `acct-${GUILD_ID}-${targetId}`;
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: acctId, guildId: GUILD_ID, platform: 'DISCORD', userId: targetId, balance: 100n, lastDailyAt: null },
    ]);

    const audit = vi.fn(async (_entry: unknown) => undefined);
    const makeCtx = () =>
      buildCommandContext(
        { group: 'admin', sub: 'remove', integers: { amount: 100 }, users: { user: { id: targetId, username: 'member' } } },
        'admin-2',
        prisma,
        GIVE_CONFIG,
        { staffLevel: 'moderator', audit },
      );
    const first = makeCtx();
    const second = makeCtx();

    await Promise.all([economyCommand.execute(first.c), economyCommand.execute(second.c)]);

    expect(getAccount(acctId)?.balance).toBe(0n);
    const removeRows = getTransactions().filter((t) => t.type === 'admin_remove');
    expect(removeRows).toHaveLength(1);

    const rejected = [first.reply(), second.reply()].filter(
      (r) => descriptionOf(r) === errorText('admin.wouldGoNegative'),
    );
    expect(rejected).toHaveLength(1);
    // The rejected call must not have audited a fictitious adjustment.
    expect(audit).toHaveBeenCalledTimes(1);
  });
});

describe('/economy daily — atomic cooldown claim (BUG 3)', () => {
  it('two concurrent daily claims from a fresh account: exactly one payout, one ledger row, the loser sees the cooldown message', async () => {
    const userId = 'daily-1';
    const acctId = `acct-${GUILD_ID}-DISCORD-${userId}`;
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: acctId, guildId: GUILD_ID, platform: 'DISCORD', userId, balance: 0n, lastDailyAt: null },
    ]);

    const makeCtx = () => buildCommandContext({ sub: 'daily' }, userId, prisma, DAILY_CONFIG);
    const first = makeCtx();
    const second = makeCtx();

    await Promise.all([economyCommand.execute(first.c), economyCommand.execute(second.c)]);

    // Both calls read the same stale `lastDailyAt: null` before the transaction — only one may actually claim.
    expect(getAccount(acctId)?.balance).toBe(50n);
    expect(getAccount(acctId)?.lastDailyAt).not.toBeNull();
    expect(getTransactions().filter((t) => t.type === 'daily')).toHaveLength(1);

    const replies = [first.reply(), second.reply()];
    const succeeded = replies.filter((r) => descriptionOf(r).includes('You claimed'));
    const cooldown = replies.filter((r) => /already claimed today/.test(descriptionOf(r)));
    expect(succeeded).toHaveLength(1);
    expect(cooldown).toHaveLength(1);
  });

  it('a second daily claim inside the cooldown window is rejected with an accurate, freshly-computed cooldown', async () => {
    const userId = 'daily-2';
    const acctId = `acct-${GUILD_ID}-DISCORD-${userId}`;
    const justClaimed = new Date(Date.now() - 60_000); // 1 minute ago — well inside the 20h cooldown
    const { prisma, getAccount, getTransactions } = buildFakeEconomyPrisma([
      { id: acctId, guildId: GUILD_ID, platform: 'DISCORD', userId, balance: 50n, lastDailyAt: justClaimed },
    ]);

    const { c, reply } = buildCommandContext({ sub: 'daily' }, userId, prisma, DAILY_CONFIG);
    await economyCommand.execute(c);

    expect(descriptionOf(reply())).toBe(
      errorText('dailyCooldown', { hours: Math.ceil(DAILY_COOLDOWN_MS / (60 * 60 * 1000)) }),
    );
    // Nothing was claimed a second time.
    expect(getAccount(acctId)?.balance).toBe(50n);
    expect(getTransactions().filter((t) => t.type === 'daily')).toHaveLength(0);
  });
});
