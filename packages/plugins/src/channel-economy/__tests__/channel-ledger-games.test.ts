import { describe, expect, it } from 'vitest';
import {
  EARNED_TRANSACTION_TYPES,
  GAME_TRANSACTION_TYPES,
  creditChannel,
  debitChannel,
  findChannelTransactionByNote,
  getChannelEarnedLeaderboard,
  settleChannelGameHand,
  type SettleGameHandInput,
} from '../ledger';
import { buildFakeChannelPrisma } from './fake-channel-prisma';

// Table games move channel currency through exactly two ledger functions: `debitChannel` (a bet) and
// `settleChannelGameHand` (the payouts, with the hand record). These tests pin the two promises the games rely
// on: a wallet can never be overdrawn by simultaneous bets, and a hand is paid exactly once.

const ECON = 'econ-1';
const key = (viewerUserId: string) => ({ economyId: ECON, viewerUserId });

function hand(overrides: Partial<SettleGameHandInput> = {}): SettleGameHandInput {
  return {
    handId: 'hand-1',
    economyId: ECON,
    game: 'BLACKJACK',
    seed: '42:0',
    startedAt: new Date('2026-11-12T00:00:00Z'),
    endedAt: new Date('2026-11-12T00:01:00Z'),
    result: { cancelled: false },
    payouts: [],
    ...overrides,
  };
}

describe('channel ledger — game transaction types', () => {
  it('are never counted as earned', () => {
    for (const type of GAME_TRANSACTION_TYPES) {
      expect((EARNED_TRANSACTION_TYPES as readonly string[]).includes(type)).toBe(false);
    }
  });

  it('winning at a table does not move anyone up the lifetime-earned board', async () => {
    const { prisma } = buildFakeChannelPrisma();
    await creditChannel(prisma, key('grinder'), 100, 'twitch_chat_earn');
    await creditChannel(prisma, key('gambler'), 10, 'twitch_chat_earn');
    await settleChannelGameHand(
      prisma,
      hand({ payouts: [{ viewerUserId: 'gambler', amount: 5000, type: 'blackjack_payout' }] }),
    );

    const board = await getChannelEarnedLeaderboard(prisma, ECON, 5);
    expect(board.map((row) => [row.viewerUserId, row.earned])).toEqual([
      ['grinder', 100n],
      ['gambler', 10n],
    ]);
  });
});

describe('channel ledger — debitChannel', () => {
  it('takes the bet and writes one blackjack_bet row from the viewer', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma([
      { economyId: ECON, viewerUserId: 'v1', balance: 100n },
    ]);
    const result = await debitChannel(prisma, key('v1'), 60, 'blackjack_bet', { note: 'bj:t1:1' });

    expect(result).toEqual({ ok: true, newBalance: 40n });
    expect(getWallet(ECON, 'v1')?.balance).toBe(40n);
    expect(getTransactions()).toHaveLength(1);
    expect(getTransactions()[0]).toMatchObject({
      type: 'blackjack_bet',
      fromUserId: 'v1',
      toUserId: null,
      amount: 60n,
      note: 'bj:t1:1',
    });
  });

  it('refuses a bet the wallet cannot cover, changing nothing and writing nothing', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma([
      { economyId: ECON, viewerUserId: 'v1', balance: 59n },
    ]);
    expect(await debitChannel(prisma, key('v1'), 60, 'blackjack_bet')).toEqual({
      ok: false,
      reason: 'insufficient_balance',
    });
    expect(getWallet(ECON, 'v1')?.balance).toBe(59n);
    expect(getTransactions()).toHaveLength(0);
  });

  it('refuses a viewer who has never had a wallet', async () => {
    const { prisma, getTransactions } = buildFakeChannelPrisma();
    expect(await debitChannel(prisma, key('new'), 1, 'blackjack_bet')).toEqual({
      ok: false,
      reason: 'insufficient_balance',
    });
    expect(getTransactions()).toHaveLength(0);
  });

  it('rejects amounts that are not positive whole numbers', async () => {
    const { prisma, getTransactions } = buildFakeChannelPrisma([
      { economyId: ECON, viewerUserId: 'v1', balance: 100n },
    ]);
    for (const bad of [0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await debitChannel(prisma, key('v1'), bad, 'blackjack_bet')).toEqual({
        ok: false,
        reason: 'invalid_amount',
      });
    }
    expect(getTransactions()).toHaveLength(0);
  });

  it('RACE: two bets placed at the same instant can never overdraw the wallet', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma([
      { economyId: ECON, viewerUserId: 'v1', balance: 100n },
    ]);
    const results = await Promise.all([
      debitChannel(prisma, key('v1'), 60, 'blackjack_bet', { note: 'a' }),
      debitChannel(prisma, key('v1'), 60, 'blackjack_bet', { note: 'b' }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'insufficient_balance' }]);
    expect(getWallet(ECON, 'v1')?.balance).toBe(40n);
    // The loser left no ledger row behind.
    expect(getTransactions()).toHaveLength(1);
  });

  it('RACE: twenty simultaneous bets spend exactly what the wallet holds and never more', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma([
      { economyId: ECON, viewerUserId: 'v1', balance: 100n },
    ]);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        debitChannel(prisma, key('v1'), 15, 'blackjack_bet', { note: `n${i}` }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(6);
    expect(getWallet(ECON, 'v1')?.balance).toBe(10n);
    expect(getTransactions()).toHaveLength(6);
  });

  it('can be looked up by its note afterwards', async () => {
    const { prisma } = buildFakeChannelPrisma([{ economyId: ECON, viewerUserId: 'v1', balance: 100n }]);
    await debitChannel(prisma, key('v1'), 10, 'blackjack_bet', { note: 'bj:t1:7' });
    expect(await findChannelTransactionByNote(prisma, ECON, 'bj:t1:7')).toBe(true);
    expect(await findChannelTransactionByNote(prisma, ECON, 'bj:t1:8')).toBe(false);
    expect(await findChannelTransactionByNote(prisma, 'other-econ', 'bj:t1:7')).toBe(false);
  });
});

describe('channel ledger — settleChannelGameHand', () => {
  const payouts: SettleGameHandInput['payouts'] = [
    { viewerUserId: 'winner', amount: 200, type: 'blackjack_payout' },
    { viewerUserId: 'pusher', amount: 50, type: 'blackjack_push' },
    { viewerUserId: 'loser', amount: 0, type: 'blackjack_payout' },
  ];

  it('records the hand and pays every seat, with one audit row per balance change', async () => {
    const { prisma, getWallet, getTransactions, getGameHands } = buildFakeChannelPrisma();
    const result = await settleChannelGameHand(
      prisma,
      hand({ payouts, result: { cancelled: false, seats: 3 } }),
    );

    expect(result).toEqual({ ok: true, alreadySettled: false });
    expect(getGameHands()).toHaveLength(1);
    expect(getGameHands()[0]).toMatchObject({
      id: 'hand-1',
      economyId: ECON,
      game: 'BLACKJACK',
      seed: '42:0',
    });
    expect(getWallet(ECON, 'winner')?.balance).toBe(200n);
    expect(getWallet(ECON, 'pusher')?.balance).toBe(50n);
    // A loss changes no balance, so it writes no row (the bet's own row is its audit trail).
    expect(getWallet(ECON, 'loser')).toBeUndefined();
    expect(getTransactions().map((t) => [t.type, t.toUserId, t.amount, t.note])).toEqual([
      ['blackjack_payout', 'winner', 200n, 'hand:hand-1'],
      ['blackjack_push', 'pusher', 50n, 'hand:hand-1'],
    ]);
  });

  it('pays once: settling the same hand again changes nothing', async () => {
    const { prisma, getWallet, getTransactions, getGameHands } = buildFakeChannelPrisma();
    await settleChannelGameHand(prisma, hand({ payouts }));
    const again = await settleChannelGameHand(prisma, hand({ payouts }));

    expect(again).toEqual({ ok: true, alreadySettled: true });
    expect(getWallet(ECON, 'winner')?.balance).toBe(200n);
    expect(getTransactions()).toHaveLength(2);
    expect(getGameHands()).toHaveLength(1);
  });

  it('RACE: two settles of the same hand at the same instant pay once', async () => {
    const { prisma, getWallet, getTransactions } = buildFakeChannelPrisma();
    const results = await Promise.all([
      settleChannelGameHand(prisma, hand({ payouts })),
      settleChannelGameHand(prisma, hand({ payouts })),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.alreadySettled)).toHaveLength(1);
    expect(getWallet(ECON, 'winner')?.balance).toBe(200n);
    expect(getTransactions()).toHaveLength(2);
  });

  it('is all or nothing: when the database fails, no hand is recorded and nobody is paid', async () => {
    const { prisma, allWallets, getTransactions, getGameHands, failNextTransaction } =
      buildFakeChannelPrisma();
    failNextTransaction();

    await expect(settleChannelGameHand(prisma, hand({ payouts }))).rejects.toThrow('database unavailable');
    expect(getGameHands()).toHaveLength(0);
    expect(getTransactions()).toHaveLength(0);
    expect(allWallets()).toHaveLength(0);

    // ...and the retry then settles it normally.
    expect(await settleChannelGameHand(prisma, hand({ payouts }))).toEqual({
      ok: true,
      alreadySettled: false,
    });
    expect(getTransactions()).toHaveLength(2);
  });

  it('records a hand that pays nobody (everyone lost)', async () => {
    const { prisma, getTransactions, getGameHands } = buildFakeChannelPrisma();
    await settleChannelGameHand(prisma, hand({ payouts: [] }));
    expect(getGameHands()).toHaveLength(1);
    expect(getTransactions()).toHaveLength(0);
  });

  it('rejects a negative or fractional payout before writing anything', async () => {
    const { prisma, getGameHands } = buildFakeChannelPrisma();
    for (const amount of [-1, 2.5]) {
      expect(
        await settleChannelGameHand(
          prisma,
          hand({ payouts: [{ viewerUserId: 'v', amount, type: 'blackjack_payout' }] }),
        ),
      ).toEqual({ ok: false, reason: 'invalid_amount' });
    }
    expect(getGameHands()).toHaveLength(0);
  });

  it('adds to an existing balance rather than replacing it', async () => {
    const { prisma, getWallet } = buildFakeChannelPrisma([
      { economyId: ECON, viewerUserId: 'winner', balance: 40n },
    ]);
    await settleChannelGameHand(prisma, hand({ payouts }));
    expect(getWallet(ECON, 'winner')?.balance).toBe(240n);
  });
});
