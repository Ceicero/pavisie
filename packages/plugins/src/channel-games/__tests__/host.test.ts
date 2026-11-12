import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { debitChannel } from '../../channel-economy/ledger';
import { buildFakeChannelPrisma } from '../../channel-economy/__tests__/fake-channel-prisma';
import type { BlackjackIntent, BlackjackIntentKind } from '../blackjack/commands';
import type { BlackjackTable } from '../blackjack/table';
import type { Card } from '../deck';
import { ChannelGameHost, type GameEconomy } from '../host';
import type { CoalescingOutbound } from '../outbound';
import { stackedShoe } from './helpers';

// The table host end to end: real rules, real ledger functions (over the in-memory fake database), a real Redis
// mock, and a recording stand-in for the chat queue. Time is a number the test moves by hand.

const ECON = 'econ-1';
const CHANNEL = { broadcasterUserId: 'b-1', commandPrefix: '!' };
const ECONOMY: GameEconomy = { id: ECON, currencySymbol: '♦️', blackjackMinBet: 10, blackjackMaxBet: 500 };
const TABLE_KEY = 'pavisie:games:table:b-1';
const SHOE_KEY = 'pavisie:games:shoe:blackjack:b-1';
const START_BALANCE = 1000n;

interface Line {
  text: string;
  key?: string;
  keep?: boolean;
}

function setup(viewers = 10) {
  const redis = new RedisMock() as unknown as Redis;
  const db = buildFakeChannelPrisma(
    Array.from({ length: viewers }, (_, i) => ({
      economyId: ECON,
      viewerUserId: `p${i + 1}`,
      balance: START_BALANCE,
    })),
  );
  const clock = { now: 1_000_000 };
  const lines: Line[] = [];
  const logs: unknown[][] = [];
  const outbound = {
    enqueue: (_channel: string, text: string, options: { key?: string; keep?: boolean } = {}) => {
      lines.push({ text, ...options });
    },
  } as unknown as CoalescingOutbound;
  let ids = 0;

  const makeHost = () =>
    new ChannelGameHost({
      prisma: db.prisma,
      redis,
      outbound,
      logger: {
        warn: (...args: unknown[]) => logs.push(args),
        error: (...args: unknown[]) => logs.push(args),
      },
      now: () => clock.now,
      newSeed: () => 4242,
      newId: () => `table-${++ids}`,
    });
  let host = makeHost();

  const cmd = (
    kind: BlackjackIntentKind,
    viewer: string,
    options: { amount?: number; mod?: boolean; name?: string } = {},
  ) => {
    const intent: BlackjackIntent = {
      kind,
      commandName: 'bj',
      viaAlias: false,
      amount: options.amount ?? null,
    };
    return host.handleBlackjack(
      CHANNEL,
      ECONOMY,
      { userId: viewer, displayName: options.name ?? `Name_${viewer}`, isModerator: options.mod ?? false },
      intent,
    );
  };

  return {
    redis,
    db,
    clock,
    lines,
    logs,
    cmd,
    host: () => host,
    /** Throws the host away and builds a new one over the same Redis and database: a bot restart. */
    restart: () => {
      host = makeHost();
      return host;
    },
    stackShoe: (cards: Card[]) => redis.set(SHOE_KEY, JSON.stringify(stackedShoe(cards))),
    table: async () => {
      const raw = await redis.get(TABLE_KEY);
      return raw ? (JSON.parse(raw) as BlackjackTable) : null;
    },
    balance: (viewer: string) => db.getWallet(ECON, viewer)?.balance,
    said: (fragment: string) => lines.filter((line) => line.text.includes(fragment)),
    advance: async (ms: number) => {
      clock.now += ms;
      await host.tick();
    },
  };
}

/** Opens a table and seats `bets` (viewers p1..pn), leaving it in the lobby. */
async function seated(t: ReturnType<typeof setup>, bets: number[]) {
  await t.cmd('start', 'mod', { mod: true });
  for (let i = 0; i < bets.length; i += 1) await t.cmd('join', `p${i + 1}`, { amount: bets[i] });
}

beforeEach(async () => {
  await (new RedisMock() as unknown as Redis).flushall();
});

describe('a full hand', () => {
  it('plays two seats through with correct payouts, ledger rows and hand record', async () => {
    const t = setup();
    // p1: 10+9 = 19. p2: A+K = blackjack. Dealer: 10+8 = 18.
    await t.stackShoe(['TS', 'AS', 'TD', '9S', 'KS', '8D']);
    await seated(t, [50, 100]);
    expect(t.balance('p1')).toBe(950n);
    expect(t.balance('p2')).toBe(900n);

    await t.cmd('deal', 'mod', { mod: true });
    expect((await t.table())?.turn).toEqual({ seat: 0, hand: 0 });
    await t.cmd('stand', 'p1');

    // p1 wins 1:1 (+50). p2's blackjack pays 3:2 (+150).
    expect(t.balance('p1')).toBe(1050n);
    expect(t.balance('p2')).toBe(1150n);
    expect(await t.table()).toBeNull();

    expect(t.db.getTransactions().map((tx) => [tx.type, tx.fromUserId ?? tx.toUserId, tx.amount])).toEqual([
      ['blackjack_bet', 'p1', 50n],
      ['blackjack_bet', 'p2', 100n],
      ['blackjack_payout', 'p1', 100n],
      ['blackjack_payout', 'p2', 250n],
    ]);

    const [hand] = t.db.getGameHands();
    expect(hand).toMatchObject({ id: 'table-1', economyId: ECON, game: 'BLACKJACK', seed: '7:0' });
    expect(hand?.result).toMatchObject({
      cancelled: false,
      dealer: { cards: ['TD', '8D'], total: 18 },
      seats: [
        { viewerUserId: 'p1', staked: 50, payout: 100 },
        { viewerUserId: 'p2', staked: 100, payout: 250 },
      ],
    });

    const result = t.lines[t.lines.length - 1];
    expect(result?.keep).toBe(true);
    expect(result?.text).toContain('Dealer: 10♦ 8♦ (18)');
    expect(result?.text).toContain('Name_p1 win +50');
    expect(result?.text).toContain('Name_p2 blackjack +150');
  });

  it('seats eight, deals as soon as the table is full, and pays everyone correctly', async () => {
    const t = setup();
    // First cards 10 each; dealer 10. Second cards: 7,8,9,10,7,8,9,10 -> totals 17,18,19,20,17,18,19,20; dealer 10+8 = 18.
    const first: Card[] = ['TS', 'TS', 'TS', 'TS', 'TS', 'TS', 'TS', 'TS', 'TD'];
    const second: Card[] = ['7S', '8S', '9S', 'KS', '7H', '8H', '9H', 'KH', '8D'];
    await t.stackShoe([...first, ...second]);
    await seated(t, [10, 20, 30, 40, 50, 60, 70, 80]);

    // The eighth join filled the table: it dealt without waiting for the lobby timer.
    expect((await t.table())?.phase).toBe('playing');
    for (let i = 1; i <= 8; i += 1) await t.cmd('stand', `p${i}`);
    expect(await t.table()).toBeNull();

    // 17 loses, 18 pushes, 19 and 20 win.
    const expected = [-10, 0, 30, 40, -50, 0, 70, 80];
    expected.forEach((net, i) => expect(t.balance(`p${i + 1}`)).toBe(START_BALANCE + BigInt(net)));

    // The house took exactly what the players lost and paid exactly what they won.
    const txs = t.db.getTransactions();
    const total = (type: string) =>
      txs.filter((tx) => tx.type === type).reduce((sum, tx) => sum + tx.amount, 0n);
    expect(total('blackjack_bet')).toBe(360n);
    expect(total('blackjack_payout')).toBe(440n);
    expect(total('blackjack_push')).toBe(80n);
    expect(t.db.getGameHands()).toHaveLength(1);
  });

  it('handles a double and a split with the right extra bets', async () => {
    const t = setup();
    // p1: 5+6, doubles, draws K = 21. p2: 8+8, splits -> 8+3 and 8+2. Dealer 10+7 = 17.
    await t.stackShoe(['5S', '8S', 'TD', '6S', '8H', '7D', 'KS', '3S', '2S', 'TS', '9S']);
    await seated(t, [100, 40]);
    await t.cmd('deal', 'mod', { mod: true });

    await t.cmd('double', 'p1');
    expect(t.balance('p1')).toBe(800n);
    await t.cmd('split', 'p2');
    expect(t.balance('p2')).toBe(920n);
    await t.cmd('hit', 'p2'); // 8+3+10 = 21, moves to the second split hand
    await t.cmd('hit', 'p2'); // 8+2+9 = 19
    await t.cmd('stand', 'p2');

    // p1: staked 200, wins 400. p2: both hands win, staked 80, gets 160.
    expect(t.balance('p1')).toBe(1200n);
    expect(t.balance('p2')).toBe(1080n);
  });

  it('settles at once when the dealer has blackjack', async () => {
    const t = setup();
    await t.stackShoe(['TS', 'AS', 'AD', '9S', 'KS', 'KD']);
    await seated(t, [50, 50]);
    await t.cmd('deal', 'mod', { mod: true });

    expect(await t.table()).toBeNull();
    expect(t.balance('p1')).toBe(950n); // lost
    expect(t.balance('p2')).toBe(1000n); // blackjack against blackjack: bet returned
    expect(t.db.getTransactions().filter((tx) => tx.type === 'blackjack_push')).toHaveLength(1);
  });

  it('keeps dealing from the same shoe on the next table', async () => {
    const t = setup();
    await t.stackShoe(['TS', 'TD', '9S', '8D', 'KS', 'KD', 'QS', 'QD']);
    await seated(t, [50]);
    await t.cmd('deal', 'mod', { mod: true });
    await t.cmd('stand', 'p1');

    await seated(t, [50]);
    await t.cmd('deal', 'mod', { mod: true });
    const table = await t.table();
    expect(table?.seats[0]?.hands[0]?.cards).toEqual(['KS', 'QS']);
    expect(table?.dealtFrom).toEqual({ seed: 7, offset: 4 });
  });
});

describe('opening, joining and leaving', () => {
  it('lets only the streamer or a mod open, deal or cancel a table', async () => {
    const t = setup();
    await t.cmd('start', 'p1');
    expect(await t.table()).toBeNull();
    expect(t.said('only the streamer or a mod')).toHaveLength(1);

    await t.cmd('start', 'mod', { mod: true });
    expect((await t.table())?.phase).toBe('lobby');
    await t.cmd('join', 'p1', { amount: 50 });
    await t.cmd('deal', 'p1');
    await t.cmd('stop', 'p1');
    expect((await t.table())?.phase).toBe('lobby');
  });

  it('refuses a second table while one is running', async () => {
    const t = setup();
    await t.cmd('start', 'mod', { mod: true });
    await t.cmd('start', 'mod', { mod: true });
    expect(t.said('already running')).toHaveLength(1);
    expect(t.said('table is open')).toHaveLength(1);
  });

  it('takes the bet on joining and enforces the table limits without taking anything', async () => {
    const t = setup();
    await t.cmd('start', 'mod', { mod: true });
    await t.cmd('join', 'p1', { amount: 5 });
    await t.cmd('join', 'p2', { amount: 501 });
    await t.cmd('join', 'p3');
    expect(t.balance('p1')).toBe(1000n);
    expect(t.balance('p2')).toBe(1000n);
    expect(t.said('below the table minimum')).toHaveLength(1);
    expect(t.said('above the table maximum')).toHaveLength(1);
    expect(t.said('whole number')).toHaveLength(1);

    await t.cmd('join', 'p1', { amount: 500 });
    expect(t.balance('p1')).toBe(500n);
    await t.cmd('join', 'p1', { amount: 10 });
    expect(t.balance('p1')).toBe(500n);
    expect(t.said('already have a seat')).toHaveLength(1);
  });

  it('gives no seat to a viewer who cannot cover the bet', async () => {
    const t = setup();
    await t.cmd('start', 'mod', { mod: true });
    await t.cmd('join', 'broke', { amount: 50 });
    expect((await t.table())?.seats).toHaveLength(0);
    expect(t.said("don't have enough")).toHaveLength(1);
    expect(t.db.getTransactions()).toHaveLength(0);
  });

  it('returns the bet when a viewer leaves before the deal', async () => {
    const t = setup();
    await seated(t, [80, 20]);
    await t.cmd('leave', 'p1');
    expect(t.balance('p1')).toBe(1000n);
    expect((await t.table())?.seats.map((s) => s.viewerUserId)).toEqual(['p2']);
    expect(t.db.getTransactions().map((tx) => tx.type)).toEqual([
      'blackjack_bet',
      'blackjack_bet',
      'blackjack_push',
    ]);

    await t.cmd('deal', 'mod', { mod: true });
    await t.cmd('leave', 'p2');
    expect(t.said('only leave before the cards are dealt')).toHaveLength(1);
    expect(t.balance('p2')).toBe(980n);
  });

  it('RACE: ten viewers joining at the same instant fill exactly eight seats', async () => {
    const t = setup();
    // Eight seats of 10+7, dealer 10+8: nobody is dealt a natural, so the table is still there to inspect.
    await t.stackShoe([...Array<Card>(9).fill('TS'), ...Array<Card>(8).fill('7S'), '8D']);
    await t.cmd('start', 'mod', { mod: true });
    await Promise.all(Array.from({ length: 10 }, (_, i) => t.cmd('join', `p${i + 1}`, { amount: 10 })));

    const paid = Array.from({ length: 10 }, (_, i) => t.balance(`p${i + 1}`)).filter((b) => b === 990n);
    expect(paid).toHaveLength(8);
    expect(t.db.getTransactions().filter((tx) => tx.type === 'blackjack_bet')).toHaveLength(8);
    expect((await t.table())?.seats).toHaveLength(8);
    // The two who were too late paid nothing and were told why (the hand had already been dealt).
    expect(t.said('already started')).toHaveLength(2);
  });

  it('RACE: one viewer joining twice at the same instant gets one seat and pays once', async () => {
    const t = setup();
    await t.cmd('start', 'mod', { mod: true });
    await Promise.all([t.cmd('join', 'p1', { amount: 50 }), t.cmd('join', 'p1', { amount: 50 })]);
    expect((await t.table())?.seats).toHaveLength(1);
    expect(t.balance('p1')).toBe(950n);
  });

  it('refuses a double the viewer cannot afford and leaves the hand as it was', async () => {
    const t = setup();
    await t.stackShoe(['5S', 'TS', 'TD', '6S', '9S', '7D']);
    await t.cmd('start', 'mod', { mod: true });
    await t.cmd('join', 'p1', { amount: 500 });
    await t.cmd('join', 'p2', { amount: 10 });
    // p1 has 500 left; drain it so the double (another 500) cannot be covered.
    await debitChannel(t.db.prisma, { economyId: ECON, viewerUserId: 'p1' }, 400, 'blackjack_bet');
    await t.cmd('deal', 'mod', { mod: true });
    await t.cmd('double', 'p1');

    const table = await t.table();
    expect(table?.seats[0]?.hands[0]).toMatchObject({ cards: ['5S', '6S'], stake: 500, doubled: false });
    expect(table?.turn).toEqual({ seat: 0, hand: 0 });
    expect(t.balance('p1')).toBe(100n);
    expect(t.said("don't have enough")).toHaveLength(1);
  });

  it('only ever shows a cleaned-up display name', async () => {
    const t = setup();
    await t.cmd('start', 'mod', { mod: true });
    await t.cmd('join', 'p1', { amount: 50, name: '/ban everyone http://evil.example' });
    const everything = t.lines.map((line) => line.text).join('\n');
    expect(everything).toContain('baneveryone');
    expect(everything).not.toContain('/ban');
    expect(everything).not.toContain('http://');
    // No line may start with viewer-derived text.
    expect(t.lines.every((line) => line.text.startsWith('🃏'))).toBe(true);
  });
});

describe('timers', () => {
  it('deals when the lobby time runs out', async () => {
    const t = setup();
    await seated(t, [50]);
    await t.advance(39_000);
    expect((await t.table())?.phase).toBe('lobby');
    await t.advance(2_000);
    expect((await t.table())?.phase).toBe('playing');
  });

  it('closes an empty lobby without touching the ledger', async () => {
    const t = setup();
    await t.cmd('start', 'mod', { mod: true });
    await t.advance(41_000);
    expect(await t.table()).toBeNull();
    expect(t.host().hasActiveTable('b-1')).toBe(false);
    expect(t.said('Nobody sat down')).toHaveLength(1);
    expect(t.db.getGameHands()).toHaveLength(0);
  });

  it('auto-stands a player who does not act in time and moves on', async () => {
    const t = setup();
    await t.stackShoe(['TS', 'TS', 'TD', '6S', '9S', '8D']);
    await seated(t, [50, 50]);
    await t.cmd('deal', 'mod', { mod: true });

    await t.advance(24_000);
    expect((await t.table())?.turn).toEqual({ seat: 0, hand: 0 });
    await t.advance(2_000);
    const table = await t.table();
    // p1 stood on 16 without acting; it is now p2's turn with a full new timer.
    expect(table?.seats[0]?.hands[0]).toMatchObject({ cards: ['TS', '6S'], done: true });
    expect(table?.turn).toEqual({ seat: 1, hand: 0 });
    expect(table?.deadlineAt).toBe(t.clock.now + 25_000);
    expect(t.said('ran out of time')).toHaveLength(1);

    // p2 times out too: the hand finishes by itself. Dealer 18: p1 (16) loses, p2 (19) wins.
    await t.advance(26_000);
    expect(await t.table()).toBeNull();
    expect(t.balance('p1')).toBe(950n);
    expect(t.balance('p2')).toBe(1050n);
  });

  it('gives each turn its own full timer after an action', async () => {
    const t = setup();
    await t.stackShoe(['2S', 'TD', '3S', '8D', '4S']);
    await seated(t, [50]);
    await t.cmd('deal', 'mod', { mod: true });
    t.clock.now += 20_000;
    await t.cmd('hit', 'p1');
    expect((await t.table())?.deadlineAt).toBe(t.clock.now + 25_000);
    // 20s into the new turn is not a timeout, even though 40s have passed since the deal.
    await t.advance(20_000);
    expect((await t.table())?.turn).toEqual({ seat: 0, hand: 0 });
  });
});

describe('cancelling', () => {
  it('refunds every bet when a lobby is cancelled', async () => {
    const t = setup();
    await seated(t, [50, 70]);
    await t.cmd('stop', 'mod', { mod: true });

    expect(t.balance('p1')).toBe(1000n);
    expect(t.balance('p2')).toBe(1000n);
    expect(await t.table()).toBeNull();
    expect(t.db.getGameHands()[0]?.result).toMatchObject({ cancelled: true });
    expect(t.lines[t.lines.length - 1]).toMatchObject({ keep: true });
    expect(t.lines[t.lines.length - 1]?.text).toContain('Every bet has been returned');
  });

  it('refunds doubles and splits too when a hand is cancelled part-way', async () => {
    const t = setup();
    await t.stackShoe(['5S', '8S', 'TD', '6S', '8H', '7D', 'KS', '3S', '2S']);
    await seated(t, [100, 40]);
    await t.cmd('deal', 'mod', { mod: true });
    await t.cmd('double', 'p1');
    await t.cmd('split', 'p2');
    expect(t.balance('p1')).toBe(800n);
    expect(t.balance('p2')).toBe(920n);

    await t.cmd('stop', 'mod', { mod: true });
    expect(t.balance('p1')).toBe(1000n);
    expect(t.balance('p2')).toBe(1000n);
  });
});

describe('surviving a restart', () => {
  it('resumes a hand in progress from Redis with the same cards and the same turn', async () => {
    const t = setup();
    await t.stackShoe(['2S', 'TS', 'TD', '3S', '9S', '8D', '4S', 'KS']);
    await seated(t, [50, 60]);
    await t.cmd('deal', 'mod', { mod: true });
    await t.cmd('hit', 'p1'); // 2+3+4 = 9, still p1's turn
    const before = await t.table();
    expect(before?.turn).toEqual({ seat: 0, hand: 0 });

    // The bot goes down for two minutes and comes back as a brand-new process.
    t.lines.length = 0;
    t.clock.now += 120_000;
    const host = t.restart();
    expect(host.hasActiveTable('b-1')).toBe(false);
    expect(await host.resume()).toBe(1);

    const after = await t.table();
    expect(after?.seats).toEqual(before?.seats);
    expect(after?.dealer).toEqual(before?.dealer);
    expect(after?.turn).toEqual(before?.turn);
    expect(host.hasActiveTable('b-1')).toBe(true);
    expect(host.aliasApplies('b-1', 'p1')).toBe(true);
    // Nobody is timed out for the bot's downtime: the turn gets a fresh grace period.
    expect(after?.deadlineAt).toBe(t.clock.now + 15_000);
    expect(t.said('The bot restarted')).toHaveLength(1);
    expect(t.said('@Name_p1')).toHaveLength(1);

    // And the hand plays out normally: p1 hits a king (19), p2 stands on 19, dealer has 18.
    await t.cmd('hit', 'p1');
    await t.cmd('stand', 'p1');
    await t.cmd('stand', 'p2');
    expect(await t.table()).toBeNull();
    expect(t.balance('p1')).toBe(1050n);
    expect(t.balance('p2')).toBe(1060n);
    expect(t.db.getGameHands()).toHaveLength(1);
  });

  it('resumes an open lobby and still deals it', async () => {
    const t = setup();
    await seated(t, [50]);
    const host = t.restart();
    await host.resume();
    expect((await t.table())?.phase).toBe('lobby');
    await t.advance(41_000);
    expect((await t.table())?.phase).toBe('playing');
  });

  it('finishes settling a hand that was interrupted after the cards were done, paying once', async () => {
    const t = setup();
    await t.stackShoe(['TS', 'TD', '9S', '8D']);
    await seated(t, [50]);
    await t.cmd('deal', 'mod', { mod: true });
    // The database drops out at the exact moment the hand settles.
    t.db.failNextTransaction();
    await t.cmd('stand', 'p1');
    expect((await t.table())?.phase).toBe('settling');
    expect(t.balance('p1')).toBe(950n);
    expect(t.said('Dealer:')).toHaveLength(0);

    // The bot restarts while the table is still waiting to be paid.
    const host = t.restart();
    await host.resume();
    expect(await t.table()).toBeNull();
    expect(t.balance('p1')).toBe(1050n);
    expect(t.said('Dealer:')).toHaveLength(1);

    // Nothing left to pay a second time.
    await host.resume();
    await t.advance(60_000);
    expect(t.balance('p1')).toBe(1050n);
    expect(t.db.getGameHands()).toHaveLength(1);
  });

  it('retries a failed settle from the timer loop without a restart', async () => {
    const t = setup();
    await t.stackShoe(['TS', 'TD', '9S', '8D']);
    await seated(t, [50]);
    await t.cmd('deal', 'mod', { mod: true });
    t.db.failNextTransaction();
    await t.cmd('stand', 'p1');
    expect(t.logs).toHaveLength(1);

    await t.advance(6_000);
    expect(await t.table()).toBeNull();
    expect(t.balance('p1')).toBe(1050n);
    expect(t.db.getTransactions().filter((tx) => tx.type === 'blackjack_payout')).toHaveLength(1);
  });

  it('gives a seat to a viewer whose bet was taken just before a crash', async () => {
    const t = setup();
    await t.cmd('start', 'mod', { mod: true });
    // Crash window: the table recorded what it was about to do, the bet was taken, the seat was never saved.
    const table = (await t.table()) as BlackjackTable;
    table.moveSeq = 1;
    table.pending = {
      kind: 'debit',
      viewerUserId: 'p1',
      amount: 50,
      note: 'bj:table-1:1',
      then: { type: 'seat', displayName: 'Name_p1' },
    };
    await t.redis.set(TABLE_KEY, JSON.stringify(table));
    await debitChannel(t.db.prisma, { economyId: ECON, viewerUserId: 'p1' }, 50, 'blackjack_bet', {
      note: 'bj:table-1:1',
    });

    await t.restart().resume();
    const after = await t.table();
    expect(after?.seats.map((s) => [s.viewerUserId, s.bet])).toEqual([['p1', 50]]);
    expect(after?.pending).toBeNull();
    expect(t.balance('p1')).toBe(950n);
  });

  it('forgets a bet that was planned but never taken', async () => {
    const t = setup();
    await t.cmd('start', 'mod', { mod: true });
    const table = (await t.table()) as BlackjackTable;
    table.pending = {
      kind: 'debit',
      viewerUserId: 'p1',
      amount: 50,
      note: 'bj:table-1:1',
      then: { type: 'seat', displayName: 'Name_p1' },
    };
    await t.redis.set(TABLE_KEY, JSON.stringify(table));

    await t.restart().resume();
    expect((await t.table())?.seats).toHaveLength(0);
    expect(t.balance('p1')).toBe(1000n);
  });

  it('pays a refund that was interrupted, exactly once', async () => {
    const t = setup();
    await seated(t, [50]);
    const table = (await t.table()) as BlackjackTable;
    // p1 left: the seat is gone and the refund was written down but never paid.
    table.seats = [];
    table.pending = {
      kind: 'credit',
      viewerUserId: 'p1',
      amount: 50,
      note: 'bj:table-1:2',
      then: { type: 'none' },
    };
    await t.redis.set(TABLE_KEY, JSON.stringify(table));

    await t.restart().resume();
    expect(t.balance('p1')).toBe(1000n);
    await t.restart().resume();
    await t.cmd('status', 'p2');
    expect(t.balance('p1')).toBe(1000n);
    expect(t.db.getTransactions().filter((tx) => tx.type === 'blackjack_push')).toHaveLength(1);
  });
});

describe('short aliases', () => {
  it('apply only while a lobby is open or the viewer is seated', async () => {
    const t = setup();
    const host = t.host();
    expect(host.aliasApplies('b-1', 'p1')).toBe(false);

    await t.cmd('start', 'mod', { mod: true });
    // Lobby open: anyone may !join.
    expect(host.aliasApplies('b-1', 'p1')).toBe(true);
    expect(host.aliasApplies('b-1', 'stranger')).toBe(true);
    expect(host.aliasApplies('other-channel', 'p1')).toBe(false);

    await t.stackShoe(['TS', 'TD', '6S', '8D']);
    await t.cmd('join', 'p1', { amount: 50 });
    await t.cmd('deal', 'mod', { mod: true });
    // Hand in progress: only seated viewers.
    expect(host.aliasApplies('b-1', 'p1')).toBe(true);
    expect(host.aliasApplies('b-1', 'stranger')).toBe(false);

    await t.cmd('stand', 'p1');
    expect(host.aliasApplies('b-1', 'p1')).toBe(false);
  });
});

describe('failures', () => {
  it('tells the viewer to try again and logs no chat text when a step throws', async () => {
    const t = setup();
    await t.cmd('start', 'mod', { mod: true });
    const mget = vi.spyOn(t.redis, 'mget').mockRejectedValueOnce(new Error('redis unavailable'));
    await t.cmd('join', 'p1', { amount: 50, name: 'SecretName' });
    mget.mockRestore();

    expect(t.said('busy for a moment')).toHaveLength(1);
    expect(t.logs).toHaveLength(1);
    expect(JSON.stringify(t.logs)).not.toContain('SecretName');
    expect(t.balance('p1')).toBe(1000n);
  });
});
