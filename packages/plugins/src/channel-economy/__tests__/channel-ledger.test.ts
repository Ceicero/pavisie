import { describe, expect, it } from 'vitest';
import {
  EARNED_TRANSACTION_TYPES,
  adminAdjustChannel,
  claimChannelDaily,
  creditChannel,
  findChannelWallet,
  getChannelBalanceLeaderboard,
  getChannelEarnedLeaderboard,
  getOrCreateChannelWallet,
  giveChannel,
} from '../ledger';
import { DAILY_COOLDOWN_MS, STREAK_CONTINUES_WITHIN_MS, encodeStreakNote } from '../../economy/service';
import { adminAdjust, claimDaily, credit, give } from '../../economy/ledger';
import { buildFakeEconomyPrisma } from '../../economy/__tests__/fake-economy-prisma';
import { buildFakeChannelPrisma } from './fake-channel-prisma';

const ECON = 'econ-1';
const OTHER_ECON = 'econ-2';

const DAILY_CONFIG = { dailyMinAmount: 50, dailyMaxAmount: 50, streakBonusPerDay: 0, streakBonusMax: 0 };
const STREAK_CONFIG = { dailyMinAmount: 50, dailyMaxAmount: 50, streakBonusPerDay: 10, streakBonusMax: 30 };
const GIVE_CONFIG = { giveMinAmount: 2, giveMaxAmount: 1000 };

const key = (viewerUserId: string, economyId = ECON) => ({ economyId, viewerUserId });

describe('channel ledger — wallets', () => {
  it('a wallet is scoped to its economy: the same viewer id in two channels never shares a balance', async () => {
    const { prisma, getWallet } = buildFakeChannelPrisma();
    await creditChannel(prisma, key('v1', ECON), 10, 'twitch_chat_earn');
    await creditChannel(prisma, key('v1', OTHER_ECON), 3, 'twitch_chat_earn');
    expect(getWallet(ECON, 'v1')?.balance).toBe(10n);
    expect(getWallet(OTHER_ECON, 'v1')?.balance).toBe(3n);
  });

  it('stores a displayName and refreshes it on a later call; omitting it never wipes it', async () => {
    const { prisma, getWallet } = buildFakeChannelPrisma();
    await getOrCreateChannelWallet(prisma, key('v1'), 'OldName');
    expect(getWallet(ECON, 'v1')?.displayName).toBe('OldName');
    await getOrCreateChannelWallet(prisma, key('v1'), 'NewName');
    expect(getWallet(ECON, 'v1')?.displayName).toBe('NewName');
    await getOrCreateChannelWallet(prisma, key('v1'));
    expect(getWallet(ECON, 'v1')?.displayName).toBe('NewName');
  });

  it('findChannelWallet is read-only: a missing wallet stays missing', async () => {
    const { prisma, allWallets } = buildFakeChannelPrisma();
    expect(await findChannelWallet(prisma, key('ghost'))).toBeNull();
    expect(allWallets()).toHaveLength(0);
  });
});

describe('channel ledger — claimChannelDaily', () => {
  it('pays out, sets lastDailyAt, and writes one append-only daily transaction carrying the streak note', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma();
    const now = new Date('2026-03-01T12:00:00Z');
    const result = await claimChannelDaily(prisma, key('v1'), DAILY_CONFIG, now, () => 0, 'Viewer');

    expect(result).toEqual({ ok: true, amount: 50n, streak: 1 });
    expect(getWallet(ECON, 'v1')).toMatchObject({ balance: 50n, displayName: 'Viewer' });
    expect(getWallet(ECON, 'v1')?.lastDailyAt?.getTime()).toBe(now.getTime());
    expect(getTransactions()).toHaveLength(1);
    expect(getTransactions()[0]).toMatchObject({
      economyId: ECON,
      type: 'daily',
      toUserId: 'v1',
      amount: 50n,
      note: encodeStreakNote(1),
    });
  });

  it('rejects a second claim inside the 20h cooldown with the remaining time, writing nothing', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma();
    const t0 = new Date('2026-03-01T00:00:00Z');
    await claimChannelDaily(prisma, key('v1'), DAILY_CONFIG, t0, () => 0);
    const t1 = new Date(t0.getTime() + 5 * 60 * 60 * 1000);
    const again = await claimChannelDaily(prisma, key('v1'), DAILY_CONFIG, t1, () => 0);

    expect(again).toEqual({ ok: false, retryAfterMs: DAILY_COOLDOWN_MS - 5 * 60 * 60 * 1000 });
    expect(getWallet(ECON, 'v1')?.balance).toBe(50n);
    expect(getTransactions()).toHaveLength(1);
  });

  it('extends the streak when claimed again within 48h, and caps the bonus at streakBonusMax', async () => {
    const { prisma } = buildFakeChannelPrisma();
    let now = new Date('2026-03-01T00:00:00Z');
    const amounts: bigint[] = [];
    const streaks: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await claimChannelDaily(prisma, key('v1'), STREAK_CONFIG, now, () => 0);
      expect(r.ok).toBe(true);
      if (r.ok) {
        amounts.push(r.amount);
        streaks.push(r.streak);
      }
      now = new Date(now.getTime() + DAILY_COOLDOWN_MS + 60_000);
    }
    expect(streaks).toEqual([1, 2, 3, 4, 5]);
    // 50 + min(30, streak*10): 60, 70, 80, 80, 80
    expect(amounts).toEqual([60n, 70n, 80n, 80n, 80n]);
  });

  it('resets the streak to 1 when the last claim is older than 48h', async () => {
    const { prisma } = buildFakeChannelPrisma();
    const t0 = new Date('2026-03-01T00:00:00Z');
    await claimChannelDaily(prisma, key('v1'), STREAK_CONFIG, t0, () => 0);
    await claimChannelDaily(prisma, key('v1'), STREAK_CONFIG, new Date(t0.getTime() + DAILY_COOLDOWN_MS + 1000), () => 0);
    const late = await claimChannelDaily(
      prisma,
      key('v1'),
      STREAK_CONFIG,
      new Date(t0.getTime() + DAILY_COOLDOWN_MS + 1000 + STREAK_CONTINUES_WITHIN_MS + 1000),
      () => 0,
    );
    expect(late).toMatchObject({ ok: true, streak: 1 });
  });

  it("reads the streak only from THIS economy's daily transactions", async () => {
    const { prisma, seedTransaction, getWallet } = buildFakeChannelPrisma([
      { economyId: ECON, viewerUserId: 'v1', lastDailyAt: new Date('2026-03-01T00:00:00Z') },
    ]);
    seedTransaction({ economyId: OTHER_ECON, toUserId: 'v1', type: 'daily', amount: 5n, note: encodeStreakNote(9) });
    seedTransaction({ economyId: ECON, walletId: getWallet(ECON, 'v1')!.id, toUserId: 'v1', type: 'daily', amount: 5n, note: encodeStreakNote(2) });

    const r = await claimChannelDaily(prisma, key('v1'), DAILY_CONFIG, new Date('2026-03-02T00:00:00Z'), () => 0);
    expect(r).toMatchObject({ ok: true, streak: 3 });
  });

  it("claiming in one channel never starts the cooldown in another channel's currency", async () => {
    const { prisma } = buildFakeChannelPrisma();
    const now = new Date('2026-03-01T00:00:00Z');
    expect((await claimChannelDaily(prisma, key('v1', ECON), DAILY_CONFIG, now, () => 0)).ok).toBe(true);
    expect((await claimChannelDaily(prisma, key('v1', OTHER_ECON), DAILY_CONFIG, now, () => 0)).ok).toBe(true);
    expect((await claimChannelDaily(prisma, key('v1', ECON), DAILY_CONFIG, now, () => 0)).ok).toBe(false);
  });

  it('two concurrent claims on one wallet: exactly one pays out, the loser reports a retry time and writes no ledger row', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma();
    const now = new Date('2026-03-01T00:00:00Z');
    const results = await Promise.all([
      claimChannelDaily(prisma, key('v1'), DAILY_CONFIG, now, () => 0),
      claimChannelDaily(prisma, key('v1'), DAILY_CONFIG, now, () => 0),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser).toEqual({ ok: false, retryAfterMs: DAILY_COOLDOWN_MS });
    expect(getWallet(ECON, 'v1')?.balance).toBe(50n);
    expect(getTransactions().filter((t) => t.type === 'daily')).toHaveLength(1);
  });

  it('many concurrent claims still pay exactly once', async () => {
    const { prisma, getWallet } = buildFakeChannelPrisma();
    const now = new Date('2026-03-01T00:00:00Z');
    const results = await Promise.all(
      Array.from({ length: 12 }, () => claimChannelDaily(prisma, key('v1'), DAILY_CONFIG, now, () => 0)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(getWallet(ECON, 'v1')?.balance).toBe(50n);
  });
});

describe('channel ledger — giveChannel', () => {
  function seeded() {
    return buildFakeChannelPrisma([
      { economyId: ECON, viewerUserId: 'alice', balance: 100n },
      { economyId: ECON, viewerUserId: 'bob', balance: 5n },
    ]);
  }

  it('moves the balance and writes exactly one give transaction against the sender wallet', async () => {
    const { prisma, getWallet, getTransactions } = seeded();
    const r = await giveChannel(prisma, ECON, 'alice', 'bob', 40, GIVE_CONFIG);
    expect(r).toEqual({ ok: true });
    expect(getWallet(ECON, 'alice')?.balance).toBe(60n);
    expect(getWallet(ECON, 'bob')?.balance).toBe(45n);
    const rows = getTransactions().filter((t) => t.type === 'give');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      economyId: ECON,
      walletId: getWallet(ECON, 'alice')!.id,
      fromUserId: 'alice',
      toUserId: 'bob',
      amount: 40n,
    });
  });

  it('creates the recipient wallet on a successful give and stores the display names', async () => {
    const { prisma, getWallet } = seeded();
    await giveChannel(prisma, ECON, 'alice', 'carol', 10, GIVE_CONFIG, { fromDisplayName: 'Alice', toDisplayName: 'Carol' });
    expect(getWallet(ECON, 'carol')).toMatchObject({ balance: 10n, displayName: 'Carol' });
    expect(getWallet(ECON, 'alice')?.displayName).toBe('Alice');
  });

  const rejections: Array<[string, number, string, string, { botUserId?: string }?]> = [
    ['self', 10, 'alice', 'alice'],
    ['bot', 10, 'alice', 'bot-1', { botUserId: 'bot-1' }],
    ['below_min', 1, 'alice', 'bob'],
    ['above_max', 1001, 'alice', 'bob'],
    ['insufficient_balance', 500, 'alice', 'bob'],
  ];
  for (const [reason, amount, from, to, options] of rejections) {
    it(`rejects "${reason}" with no balance change, no transaction and no recipient wallet`, async () => {
      const { prisma, getWallet, getTransactions } = seeded();
      const r = await giveChannel(prisma, ECON, from, to, amount, GIVE_CONFIG, options);
      expect(r).toEqual({ ok: false, reason });
      expect(getWallet(ECON, 'alice')?.balance).toBe(100n);
      expect(getWallet(ECON, 'bob')?.balance).toBe(5n);
      expect(getTransactions()).toHaveLength(0);
      if (to === 'bot-1') expect(getWallet(ECON, 'bot-1')).toBeUndefined();
    });
  }

  it('a rejected give never creates the recipient wallet (no bystander display name is stored)', async () => {
    const { prisma, getWallet } = seeded();
    await giveChannel(prisma, ECON, 'alice', 'stranger', 100_000, GIVE_CONFIG, { toDisplayName: 'Stranger' });
    expect(getWallet(ECON, 'stranger')).toBeUndefined();
  });

  it('rejects zero, negative, fractional and non-finite amounts as invalid_amount before touching anything', async () => {
    const { prisma, allWallets, getTransactions } = seeded();
    for (const amount of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(await giveChannel(prisma, ECON, 'alice', 'bob', amount, GIVE_CONFIG)).toEqual({
        ok: false,
        reason: 'invalid_amount',
      });
    }
    expect(allWallets().map((w) => w.balance)).toEqual([100n, 5n]);
    expect(getTransactions()).toHaveLength(0);
  });

  it('cannot cross channels: giving inside one economy leaves the same viewer ids in another economy untouched', async () => {
    const { prisma, getWallet } = buildFakeChannelPrisma([
      { economyId: ECON, viewerUserId: 'alice', balance: 100n },
      { economyId: OTHER_ECON, viewerUserId: 'alice', balance: 100n },
      { economyId: OTHER_ECON, viewerUserId: 'bob', balance: 0n },
    ]);
    await giveChannel(prisma, ECON, 'alice', 'bob', 30, GIVE_CONFIG);
    expect(getWallet(ECON, 'alice')?.balance).toBe(70n);
    expect(getWallet(ECON, 'bob')?.balance).toBe(30n);
    expect(getWallet(OTHER_ECON, 'alice')?.balance).toBe(100n);
    expect(getWallet(OTHER_ECON, 'bob')?.balance).toBe(0n);
  });

  it('two concurrent gives for the full balance: exactly one succeeds, no ledger row for the loser, balance never negative', async () => {
    const { prisma, getWallet, getTransactions } = seeded();
    const results = await Promise.all([
      giveChannel(prisma, ECON, 'alice', 'bob', 100, GIVE_CONFIG),
      giveChannel(prisma, ECON, 'alice', 'bob', 100, GIVE_CONFIG),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'insufficient_balance' }]);
    expect(getWallet(ECON, 'alice')?.balance).toBe(0n);
    expect(getWallet(ECON, 'bob')?.balance).toBe(105n);
    expect(getTransactions().filter((t) => t.type === 'give')).toHaveLength(1);
  });

  it('many concurrent small gives never overdraw the sender and conserve the total', async () => {
    const { prisma, getWallet } = seeded();
    const results = await Promise.all(
      Array.from({ length: 30 }, () => giveChannel(prisma, ECON, 'alice', 'bob', 10, GIVE_CONFIG)),
    );
    const succeeded = results.filter((r) => r.ok).length;
    expect(succeeded).toBe(10); // 100 / 10
    expect(getWallet(ECON, 'alice')?.balance).toBe(0n);
    expect(getWallet(ECON, 'bob')?.balance).toBe(105n);
  });
});

describe('channel ledger — creditChannel', () => {
  it('rejects 0, negative, fractional and unsafe amounts with invalid_amount, writing nothing', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma([{ economyId: ECON, viewerUserId: 'v1', balance: 10n }]);
    for (const amount of [0, -5, 1.5, Number.NaN, 2 ** 60]) {
      expect(await creditChannel(prisma, key('v1'), amount, 'twitch_chat_earn')).toEqual({ ok: false, reason: 'invalid_amount' });
    }
    expect(getWallet(ECON, 'v1')?.balance).toBe(10n);
    expect(getTransactions()).toHaveLength(0);
  });

  it('a valid credit writes one transaction with type/note and returns the new balance; displayName is stored', async () => {
    const { prisma, getTransactions, getWallet } = buildFakeChannelPrisma([{ economyId: ECON, viewerUserId: 'v1', balance: 10n }]);
    const r = await creditChannel(prisma, key('v1'), 15, 'twitch_watch_earn', { note: 'watched 30 min', displayName: 'Viewer' });
    expect(r).toEqual({ ok: true, newBalance: 25n });
    expect(getTransactions()).toHaveLength(1);
    expect(getTransactions()[0]).toMatchObject({ economyId: ECON, type: 'twitch_watch_earn', note: 'watched 30 min', amount: 15n, toUserId: 'v1' });
    expect(getWallet(ECON, 'v1')?.displayName).toBe('Viewer');
  });

  it('creates the wallet on first credit', async () => {
    const { prisma, getWallet } = buildFakeChannelPrisma();
    await creditChannel(prisma, key('new'), 5, 'twitch_chat_earn', { displayName: 'NewViewer' });
    expect(getWallet(ECON, 'new')).toMatchObject({ balance: 5n, displayName: 'NewViewer' });
  });

  it('20 concurrent credit(5) calls: final balance 100 and exactly 20 transactions', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma([{ economyId: ECON, viewerUserId: 'v1', balance: 0n }]);
    await Promise.all(Array.from({ length: 20 }, () => creditChannel(prisma, key('v1'), 5, 'twitch_chat_earn')));
    expect(getWallet(ECON, 'v1')?.balance).toBe(100n);
    expect(getTransactions()).toHaveLength(20);
  });
});

describe('channel ledger — adminAdjustChannel', () => {
  it('add: credits, writes an admin_add transaction with the reason as note and toUserId', async () => {
    const { prisma, getTransactions } = buildFakeChannelPrisma();
    const r = await adminAdjustChannel(prisma, key('v1'), 1, 25, 'giveaway winner', 'Viewer');
    expect(r).toEqual({ ok: true, newBalance: 25n });
    expect(getTransactions()).toHaveLength(1);
    expect(getTransactions()[0]).toMatchObject({ type: 'admin_add', toUserId: 'v1', amount: 25n, note: 'giveaway winner' });
  });

  it('remove: debits, writes an admin_remove transaction with fromUserId', async () => {
    const { prisma, getTransactions } = buildFakeChannelPrisma([{ economyId: ECON, viewerUserId: 'v1', balance: 50n }]);
    const r = await adminAdjustChannel(prisma, key('v1'), -1, 20, 'penalty');
    expect(r).toEqual({ ok: true, newBalance: 30n });
    expect(getTransactions()[0]).toMatchObject({ type: 'admin_remove', fromUserId: 'v1', amount: 20n, note: 'penalty' });
  });

  it('a remove larger than the balance is refused (would_go_negative), leaving the balance and ledger untouched', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma([{ economyId: ECON, viewerUserId: 'v1', balance: 30n }]);
    expect(await adminAdjustChannel(prisma, key('v1'), -1, 50)).toEqual({ ok: false, reason: 'would_go_negative' });
    expect(getWallet(ECON, 'v1')?.balance).toBe(30n);
    expect(getTransactions()).toHaveLength(0);
  });

  it('removing exactly the whole balance is allowed and lands on zero', async () => {
    const { prisma, getWallet } = buildFakeChannelPrisma([{ economyId: ECON, viewerUserId: 'v1', balance: 30n }]);
    expect(await adminAdjustChannel(prisma, key('v1'), -1, 30)).toEqual({ ok: true, newBalance: 0n });
    expect(getWallet(ECON, 'v1')?.balance).toBe(0n);
  });

  it('rejects zero/negative/fractional amounts as invalid_amount', async () => {
    const { prisma, getTransactions } = buildFakeChannelPrisma([{ economyId: ECON, viewerUserId: 'v1', balance: 30n }]);
    for (const amount of [0, -3, 2.5, Number.NaN]) {
      for (const direction of [1, -1] as const) {
        expect(await adminAdjustChannel(prisma, key('v1'), direction, amount)).toEqual({ ok: false, reason: 'invalid_amount' });
      }
    }
    expect(getTransactions()).toHaveLength(0);
  });

  it('two concurrent removes of the whole balance: exactly one succeeds, the balance never goes negative', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma([{ economyId: ECON, viewerUserId: 'v1', balance: 30n }]);
    const results = await Promise.all([
      adminAdjustChannel(prisma, key('v1'), -1, 30),
      adminAdjustChannel(prisma, key('v1'), -1, 30),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'would_go_negative' }]);
    expect(getWallet(ECON, 'v1')?.balance).toBe(0n);
    expect(getTransactions()).toHaveLength(1);
  });
});

describe('channel ledger — leaderboards', () => {
  it('earned board ranks by lifetime earned, counts only earned types, ignores give/admin, respects limit', async () => {
    const { prisma, seedTransaction, getWallet } = buildFakeChannelPrisma([
      { economyId: ECON, viewerUserId: 'a', displayName: 'A' },
      { economyId: ECON, viewerUserId: 'b', displayName: 'B' },
      { economyId: ECON, viewerUserId: 'c' },
    ]);
    const w = (v: string) => getWallet(ECON, v)!.id;
    seedTransaction({ economyId: ECON, walletId: w('a'), amount: 20n, type: 'twitch_chat_earn' });
    seedTransaction({ economyId: ECON, walletId: w('a'), amount: 30n, type: 'daily' });
    seedTransaction({ economyId: ECON, walletId: w('b'), amount: 40n, type: 'twitch_chat_earn' });
    seedTransaction({ economyId: ECON, walletId: w('b'), amount: 9999n, type: 'give' }); // not earned
    seedTransaction({ economyId: ECON, walletId: w('c'), amount: 9999n, type: 'admin_add' }); // not earned
    seedTransaction({ economyId: ECON, walletId: null, amount: 9999n, type: 'daily' }); // orphaned: excluded

    const rows = await getChannelEarnedLeaderboard(prisma, ECON, 10);
    expect(rows).toEqual([
      { viewerUserId: 'a', displayName: 'A', earned: 50n },
      { viewerUserId: 'b', displayName: 'B', earned: 40n },
    ]);
    expect(await getChannelEarnedLeaderboard(prisma, ECON, 1)).toHaveLength(1);
    expect(EARNED_TRANSACTION_TYPES).toEqual(['daily', 'twitch_chat_earn', 'twitch_watch_earn']);
  });

  it("earned board is isolated per economy: another channel's earnings never appear", async () => {
    const { prisma, seedTransaction, getWallet } = buildFakeChannelPrisma([
      { economyId: ECON, viewerUserId: 'a' },
      { economyId: OTHER_ECON, viewerUserId: 'x' },
    ]);
    seedTransaction({ economyId: ECON, walletId: getWallet(ECON, 'a')!.id, amount: 5n, type: 'daily' });
    seedTransaction({ economyId: OTHER_ECON, walletId: getWallet(OTHER_ECON, 'x')!.id, amount: 500n, type: 'daily' });
    const rows = await getChannelEarnedLeaderboard(prisma, ECON, 10);
    expect(rows.map((r) => r.viewerUserId)).toEqual(['a']);
  });

  it('an empty economy yields an empty earned board (honest empty state, not an error)', async () => {
    const { prisma } = buildFakeChannelPrisma();
    expect(await getChannelEarnedLeaderboard(prisma, ECON, 10)).toEqual([]);
  });

  it('balance board ranks by current balance, leaves out empty wallets, and stays inside one economy', async () => {
    const { prisma } = buildFakeChannelPrisma([
      { economyId: ECON, viewerUserId: 'a', balance: 5n, displayName: 'A' },
      { economyId: ECON, viewerUserId: 'b', balance: 50n },
      { economyId: ECON, viewerUserId: 'zero', balance: 0n },
      { economyId: OTHER_ECON, viewerUserId: 'x', balance: 999n },
    ]);
    expect(await getChannelBalanceLeaderboard(prisma, ECON, 10)).toEqual([
      { viewerUserId: 'b', displayName: null, balance: 50n },
      { viewerUserId: 'a', displayName: 'A', balance: 5n },
    ]);
    expect(await getChannelBalanceLeaderboard(prisma, ECON, 1)).toHaveLength(1);
  });
});

// Parity: the channel ledger must behave like `economy/ledger.ts` for the same inputs. Each scenario runs the same
// operation sequence on both ledgers (guild wallets on platform TWITCH vs a channel economy) and compares results
// and final state.
describe('channel ledger — parity with the guild ledger (economy/ledger.ts)', () => {
  const GUILD = 'g1';
  const gKey = (userId: string) => ({ guildId: GUILD, platform: 'TWITCH' as const, userId });

  it('daily claims: identical results and balances over a multi-day run', async () => {
    const g = buildFakeEconomyPrisma([]);
    const c = buildFakeChannelPrisma();
    let now = new Date('2026-03-01T00:00:00Z');
    for (let day = 0; day < 6; day++) {
      const gr = await claimDaily(g.prisma, gKey('v1'), STREAK_CONFIG, now, () => 0.5);
      const cr = await claimChannelDaily(c.prisma, key('v1'), STREAK_CONFIG, now, () => 0.5);
      expect(cr).toEqual(gr);
      // and an immediate retry
      const gr2 = await claimDaily(g.prisma, gKey('v1'), STREAK_CONFIG, now, () => 0.5);
      const cr2 = await claimChannelDaily(c.prisma, key('v1'), STREAK_CONFIG, now, () => 0.5);
      expect(cr2).toEqual(gr2);
      now = new Date(now.getTime() + (day === 3 ? STREAK_CONTINUES_WITHIN_MS + 3_600_000 : DAILY_COOLDOWN_MS + 60_000));
    }
    expect(c.getWallet(ECON, 'v1')?.balance).toBe(g.getAccount(`acct-${GUILD}-TWITCH-v1`)?.balance);
  });

  it('give / credit / admin adjust: identical outcomes for every validation branch', async () => {
    const seedBal = 100n;
    const g = buildFakeEconomyPrisma([
      { id: `acct-${GUILD}-TWITCH-alice`, guildId: GUILD, platform: 'TWITCH', userId: 'alice', balance: seedBal, lastDailyAt: null },
    ]);
    const c = buildFakeChannelPrisma([{ economyId: ECON, viewerUserId: 'alice', balance: seedBal }]);

    const cases: Array<[number, string]> = [
      [10, 'bob'], // ok
      [1, 'bob'], // below min
      [1001, 'bob'], // above max
      [10, 'alice'], // self
      [500, 'bob'], // insufficient
    ];
    for (const [amount, to] of cases) {
      const gr = await give(g.prisma, gKey('alice'), gKey(to), amount, GIVE_CONFIG);
      const cr = await giveChannel(c.prisma, ECON, 'alice', to, amount, GIVE_CONFIG);
      expect(cr).toEqual(gr);
    }
    expect(c.getWallet(ECON, 'alice')?.balance).toBe(g.getAccount(`acct-${GUILD}-TWITCH-alice`)?.balance);
    expect(c.getWallet(ECON, 'bob')?.balance).toBe(g.getAccount(`acct-${GUILD}-TWITCH-bob`)?.balance);

    for (const amount of [5, 0, -1, 1.5]) {
      const gr = await credit(g.prisma, gKey('bob'), amount, 'twitch_chat_earn');
      const cr = await creditChannel(c.prisma, key('bob'), amount, 'twitch_chat_earn');
      expect(cr).toEqual(gr);
    }

    // admin adjust: valid range matches exactly (0 / fractional are the documented tightening -> invalid_amount)
    for (const [dir, amount] of [[1, 7], [-1, 3], [-1, 1000]] as const) {
      const gr = await adminAdjust(g.prisma, gKey('bob'), dir, amount, 'why');
      const cr = await adminAdjustChannel(c.prisma, key('bob'), dir, amount, 'why');
      expect(cr).toEqual(gr);
    }
    for (const w of ['alice', 'bob']) {
      expect(c.getWallet(ECON, w)?.balance).toBe(g.getAccount(`acct-${GUILD}-TWITCH-${w}`)?.balance);
    }
    // same transaction types were written, in the same order
    expect(c.getTransactions().map((t) => [t.type, t.amount])).toEqual(g.getTransactions().map((t) => [t.type, t.amount]));
  });
});
