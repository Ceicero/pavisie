import { describe, expect, it } from 'vitest';
import type { Card } from '../deck';
import {
  MAX_SEATS,
  addSeat,
  applyAction,
  checkAction,
  checkJoin,
  createLobby,
  dealHand,
  playDealer,
  removeSeat,
  safeDisplayName,
  stakesInPlay,
  tableResults,
  timeOutTurn,
  type BlackjackTable,
} from '../blackjack/table';
import { stackedShoe } from './helpers';

function lobby(): BlackjackTable {
  return createLobby({
    tableId: 'table-1',
    economyId: 'econ-1',
    broadcasterUserId: 'b-1',
    currencySymbol: '♦️',
    commandPrefix: '!',
    minBet: 10,
    maxBet: 500,
    now: 1_000,
    lobbyMs: 40_000,
  });
}

/** A table with `bets.length` seats (viewer ids p1..pn), dealt from `cards`. */
function dealt(bets: number[], cards: Card[]) {
  const table = lobby();
  bets.forEach((bet, i) => addSeat(table, { viewerUserId: `p${i + 1}`, displayName: `Player${i + 1}`, bet }));
  const shoe = stackedShoe(cards);
  dealHand(table, shoe);
  return { table, shoe };
}

describe('lobby', () => {
  it('opens with a deadline and no seats', () => {
    const table = lobby();
    expect(table).toMatchObject({
      phase: 'lobby',
      seats: [],
      deadlineAt: 41_000,
      pending: null,
      closing: null,
    });
  });

  it('checks a join before any currency is taken', () => {
    const table = lobby();
    expect(checkJoin(table, 'p1', 50)).toBeNull();
    expect(checkJoin(table, 'p1', null)).toBe('invalid_bet');
    expect(checkJoin(table, 'p1', 0)).toBe('invalid_bet');
    expect(checkJoin(table, 'p1', 9)).toBe('bet_too_small');
    expect(checkJoin(table, 'p1', 501)).toBe('bet_too_large');
    expect(checkJoin(table, 'p1', 10)).toBeNull();
    expect(checkJoin(table, 'p1', 500)).toBeNull();

    addSeat(table, { viewerUserId: 'p1', displayName: 'One', bet: 50 });
    expect(checkJoin(table, 'p1', 50)).toBe('already_seated');
  });

  it('holds at most eight seats', () => {
    const table = lobby();
    for (let i = 0; i < MAX_SEATS; i += 1) {
      expect(checkJoin(table, `p${i}`, 10)).toBeNull();
      addSeat(table, { viewerUserId: `p${i}`, displayName: `P${i}`, bet: 10 });
    }
    expect(checkJoin(table, 'late', 10)).toBe('table_full');
  });

  it('lets a seat leave before the deal and reports the bet to refund', () => {
    const table = lobby();
    addSeat(table, { viewerUserId: 'p1', displayName: 'One', bet: 75 });
    expect(removeSeat(table, 'nobody')).toBeNull();
    expect(removeSeat(table, 'p1')).toMatchObject({ viewerUserId: 'p1', bet: 75 });
    expect(table.seats).toHaveLength(0);
  });

  it('refuses joins and leaves once the hand has started', () => {
    const { table } = dealt([50], ['TS', '9D', '7C', '8H']);
    expect(checkJoin(table, 'p2', 50)).toBe('not_lobby');
    expect(removeSeat(table, 'p1')).toBeNull();
  });
});

describe('display names', () => {
  it('keeps letters, digits and underscores in any script and drops everything else', () => {
    expect(safeDisplayName('Cool_Viewer99')).toBe('Cool_Viewer99');
    expect(safeDisplayName('日本語の名前')).toBe('日本語の名前');
    expect(safeDisplayName('/ban someone')).toBe('bansomeone');
    expect(safeDisplayName('evil http://x.y @here')).toBe('evilhttpxyhere');
    expect(safeDisplayName('!!!')).toBe('Player');
    expect(safeDisplayName('x'.repeat(60))).toHaveLength(25);
  });
});

describe('the deal', () => {
  it('deals one card to each seat, one to the dealer, then a second round', () => {
    const { table, shoe } = dealt([50, 50], ['2S', '3S', '4S', '5S', '6S', '7S']);
    expect(table.seats[0]?.hands[0]?.cards).toEqual(['2S', '5S']);
    expect(table.seats[1]?.hands[0]?.cards).toEqual(['3S', '6S']);
    expect(table.dealer).toEqual(['4S', '7S']);
    expect(shoe.dealt).toBe(6);
    expect(table).toMatchObject({
      phase: 'playing',
      turn: { seat: 0, hand: 0 },
      dealtFrom: { seed: 7, offset: 0 },
    });
  });

  it('skips a player dealt a natural', () => {
    const { table } = dealt([50, 50], ['AS', '9S', '4S', 'KS', '8S', '7S']);
    expect(table.seats[0]?.hands[0]?.done).toBe(true);
    expect(table.turn).toEqual({ seat: 1, hand: 0 });
  });

  it('ends the hand at once when the dealer has a natural', () => {
    const { table, shoe } = dealt([50, 50], ['TS', 'AS', 'AD', '9S', 'KS', 'KD']);
    expect(table.turn).toBeNull();
    playDealer(table, shoe);
    const [one, two] = tableResults(table);
    expect(one?.hands[0]).toMatchObject({ outcome: 'lose', payout: 0 });
    // The player's own natural pushes against the dealer's.
    expect(two?.hands[0]).toMatchObject({ outcome: 'push', payout: 50 });
  });
});

describe('player actions', () => {
  it('only lets the seat whose turn it is act', () => {
    const { table } = dealt([50, 50], ['TS', '9S', '4S', '6S', '8S', '7S']);
    expect(checkAction(table, 'p2', 'hit')).toEqual({ problem: 'not_your_turn', cost: 0 });
    expect(checkAction(table, 'stranger', 'hit')).toEqual({ problem: 'not_seated', cost: 0 });
    expect(checkAction(table, 'p1', 'hit')).toEqual({ problem: null, cost: 0 });
    expect(checkAction(lobby(), 'p1', 'hit')).toEqual({ problem: 'not_playing', cost: 0 });
  });

  it('hit draws a card; a bust ends the turn', () => {
    const { table, shoe } = dealt([50], ['TS', '9D', '6C', '8H', 'KC']);
    applyAction(table, shoe, 'hit');
    expect(table.seats[0]?.hands[0]).toMatchObject({ cards: ['TS', '6C', 'KC'], done: true });
    expect(table.turn).toBeNull();
  });

  it('hitting to exactly 21 stands automatically', () => {
    const { table, shoe } = dealt([50], ['TS', '9D', '6C', '8H', '5D']);
    applyAction(table, shoe, 'hit');
    expect(table.seats[0]?.hands[0]?.done).toBe(true);
  });

  it('stand passes the turn to the next seat', () => {
    const { table, shoe } = dealt([50, 50], ['TS', '9S', '4S', '6S', '8S', '7S']);
    applyAction(table, shoe, 'stand');
    expect(table.turn).toEqual({ seat: 1, hand: 0 });
    applyAction(table, shoe, 'stand');
    expect(table.turn).toBeNull();
  });

  it('double costs the bet again, takes exactly one card and ends the turn', () => {
    const { table, shoe } = dealt([50], ['5S', '9D', '6C', '8H', 'TD']);
    expect(checkAction(table, 'p1', 'double')).toEqual({ problem: null, cost: 50 });
    applyAction(table, shoe, 'double');
    expect(table.seats[0]?.hands[0]).toMatchObject({
      cards: ['5S', '6C', 'TD'],
      stake: 100,
      doubled: true,
      done: true,
    });
    expect(table.turn).toBeNull();
  });

  it('refuses a double after the first two cards', () => {
    const { table, shoe } = dealt([50], ['2S', '9D', '3C', '8H', '4D']);
    applyAction(table, shoe, 'hit');
    expect(checkAction(table, 'p1', 'double')).toEqual({ problem: 'cannot_double', cost: 0 });
  });

  it('split makes two hands, each with the original bet, played one after the other', () => {
    const { table, shoe } = dealt([50], ['8S', '9D', '8C', '7H', '2D', '3D']);
    expect(checkAction(table, 'p1', 'split')).toEqual({ problem: null, cost: 50 });
    applyAction(table, shoe, 'split');
    const hands = table.seats[0]?.hands ?? [];
    expect(hands.map((h) => h.cards)).toEqual([
      ['8S', '2D'],
      ['8C', '3D'],
    ]);
    expect(hands.every((h) => h.stake === 50 && h.fromSplit)).toBe(true);
    expect(table.turn).toEqual({ seat: 0, hand: 0 });
    applyAction(table, shoe, 'stand');
    expect(table.turn).toEqual({ seat: 0, hand: 1 });
  });

  it('allows only one split, and only on a pair', () => {
    const { table, shoe } = dealt([50], ['8S', '9D', '8C', '7H', '8D', '8H']);
    applyAction(table, shoe, 'split');
    // The first split hand is now 8-8 again, but a seat may split once.
    expect(checkAction(table, 'p1', 'split')).toEqual({ problem: 'cannot_split', cost: 0 });

    const noPair = dealt([50], ['8S', '9D', '7C', '7H']);
    expect(checkAction(noPair.table, 'p1', 'split')).toEqual({ problem: 'cannot_split', cost: 0 });
  });

  it('gives split aces one card each and no further action', () => {
    const { table, shoe } = dealt([50], ['AS', '9D', 'AC', '8H', 'KD', '4D']);
    applyAction(table, shoe, 'split');
    expect(table.seats[0]?.hands.map((h) => h.done)).toEqual([true, true]);
    expect(table.turn).toBeNull();
    playDealer(table, shoe);
    // A-K after a split is 21, paid 1:1, not 3:2.
    expect(tableResults(table)[0]?.hands[0]).toMatchObject({ total: 21, outcome: 'win', payout: 100 });
  });

  it('a timed-out turn stands on the cards it has', () => {
    const { table } = dealt([50, 50], ['TS', '9S', '4S', '6S', '8S', '7S']);
    timeOutTurn(table);
    expect(table.seats[0]?.hands[0]).toMatchObject({ cards: ['TS', '6S'], done: true });
    expect(table.turn).toEqual({ seat: 1, hand: 0 });
  });
});

describe('the dealer and the results', () => {
  it('draws to 17 and stops', () => {
    const { table, shoe } = dealt([50], ['TS', '6D', '9C', '5H', '4D', '2D']);
    applyAction(table, shoe, 'stand');
    playDealer(table, shoe);
    expect(table.dealer).toEqual(['6D', '5H', '4D', '2D']);
  });

  it('does not draw when every player hand is already decided', () => {
    const { table, shoe } = dealt([50], ['TS', '6D', '6C', '5H', 'KC']);
    applyAction(table, shoe, 'hit');
    playDealer(table, shoe);
    expect(table.dealer).toEqual(['6D', '5H']);
    expect(tableResults(table)[0]).toMatchObject({ staked: 50, payout: 0 });
  });

  it('reports stake and payout per seat across split hands', () => {
    // p1 splits 8s: first hand 8+T=18 wins, second 8+2 then stands on 10 and loses. Dealer 9+8 = 17.
    const { table, shoe } = dealt([50], ['8S', '9D', '8C', '8H', 'TD', '2D']);
    applyAction(table, shoe, 'split');
    applyAction(table, shoe, 'stand');
    applyAction(table, shoe, 'stand');
    playDealer(table, shoe);
    const [seat] = tableResults(table);
    expect(seat).toMatchObject({ staked: 100, payout: 100 });
    expect(seat?.hands.map((h) => h.outcome)).toEqual(['win', 'lose']);
  });

  it('knows what each seat has put in, for a cancellation refund', () => {
    const before = lobby();
    addSeat(before, { viewerUserId: 'p1', displayName: 'One', bet: 40 });
    expect(stakesInPlay(before)).toEqual([{ viewerUserId: 'p1', displayName: 'One', amount: 40 }]);

    const { table, shoe } = dealt([50, 30], ['5S', '9S', '4S', '6S', '8S', '7S', 'TD']);
    applyAction(table, shoe, 'double');
    expect(stakesInPlay(table).map((s) => s.amount)).toEqual([100, 30]);
  });
});
