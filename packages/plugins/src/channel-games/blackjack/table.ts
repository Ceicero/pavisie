// The blackjack table as a pure state machine. Everything here is plain data in, plain data out: no Redis, no
// ledger, no clock, no chat. The table host (`../host.ts`) owns those and calls in here to decide what happens.
//
// House rules (phase 1): six-deck shoe, dealer stands on all 17s, blackjack pays 3:2, a push returns the bet,
// double on any first two cards for exactly one more card, split a pair once. No insurance, no surrender.
// Split aces receive one card each and stand; a 21 made after a split pays as a normal win, not a blackjack.
import type { Card } from '../deck';
import { rankOf } from '../deck';
import {
  dealerShouldDraw,
  handValue,
  isBust,
  isNaturalBlackjack,
  isPair,
  settleHand,
  type HandOutcome,
} from './hand';
import { drawCard, type Shoe } from './shoe';

export const MAX_SEATS = 8;

export interface BlackjackHand {
  cards: Card[];
  /** What is riding on this hand: the seat's bet, or twice that once doubled. */
  stake: number;
  doubled: boolean;
  fromSplit: boolean;
  /** No further action is possible or wanted (stood, bust, doubled, natural, split aces, timed out). */
  done: boolean;
}

export interface BlackjackSeat {
  viewerUserId: string;
  /** Sanitised Twitch display name (see `safeDisplayName`), the only viewer-derived text a table ever shows. */
  displayName: string;
  bet: number;
  hands: BlackjackHand[];
}

export type TablePhase = 'lobby' | 'playing' | 'settling';

/** A money movement the host has promised but may not have finished; see `host.ts` for how it is resolved. */
export interface PendingMove {
  kind: 'debit' | 'credit';
  viewerUserId: string;
  amount: number;
  /** Unique per movement; written on the ledger row so a restart can tell whether it happened. */
  note: string;
  /** What to do to the table once the movement is known to have happened. */
  then: { type: 'seat'; displayName: string } | { type: 'double' } | { type: 'split' } | { type: 'none' };
}

export interface BlackjackTable {
  version: 1;
  game: 'BLACKJACK';
  /** Also the id of the `ChannelGameHand` row this table settles into, which is what makes settling idempotent. */
  tableId: string;
  economyId: string;
  broadcasterUserId: string;
  currencySymbol: string;
  /** The channel's command prefix when the table opened, for prompts sent from timers. */
  commandPrefix: string;
  minBet: number;
  maxBet: number;
  phase: TablePhase;
  seats: BlackjackSeat[];
  dealer: Card[];
  /** Whose turn it is while `phase` is "playing"; null once every hand is done. */
  turn: { seat: number; hand: number } | null;
  /** When the lobby closes or the current turn times out (epoch ms). */
  deadlineAt: number;
  createdAt: number;
  /** Set when the cards are dealt: which shoe, and how far into it, this hand started. */
  dealtFrom: { seed: number; offset: number } | null;
  /** Counter for unique ledger notes. */
  moveSeq: number;
  pending: PendingMove | null;
  /** Why the table is settling: a played hand, or a cancellation that refunds every stake. */
  closing: 'played' | 'cancelled' | null;
}

/** Twitch display names are letters, digits and underscores (in any script). Anything else is dropped, so a name
 * can never smuggle a chat command, a link or markup into something the bot says. */
export function safeDisplayName(raw: string): string {
  const cleaned = raw.replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 25);
  return cleaned.length > 0 ? cleaned : 'Player';
}

export function createLobby(input: {
  tableId: string;
  economyId: string;
  broadcasterUserId: string;
  currencySymbol: string;
  commandPrefix: string;
  minBet: number;
  maxBet: number;
  now: number;
  lobbyMs: number;
}): BlackjackTable {
  return {
    version: 1,
    game: 'BLACKJACK',
    tableId: input.tableId,
    economyId: input.economyId,
    broadcasterUserId: input.broadcasterUserId,
    currencySymbol: input.currencySymbol,
    commandPrefix: input.commandPrefix,
    minBet: input.minBet,
    maxBet: input.maxBet,
    phase: 'lobby',
    seats: [],
    dealer: [],
    turn: null,
    deadlineAt: input.now + input.lobbyMs,
    createdAt: input.now,
    dealtFrom: null,
    moveSeq: 0,
    pending: null,
    closing: null,
  };
}

export function findSeatIndex(table: BlackjackTable, viewerUserId: string): number {
  return table.seats.findIndex((seat) => seat.viewerUserId === viewerUserId);
}

export type JoinProblem =
  'not_lobby' | 'already_seated' | 'table_full' | 'invalid_bet' | 'bet_too_small' | 'bet_too_large';

/** Whether `viewerUserId` may take a seat for `bet`. Checked before any currency is taken. */
export function checkJoin(
  table: BlackjackTable,
  viewerUserId: string,
  bet: number | null,
): JoinProblem | null {
  if (table.phase !== 'lobby') return 'not_lobby';
  if (findSeatIndex(table, viewerUserId) !== -1) return 'already_seated';
  if (table.seats.length >= MAX_SEATS) return 'table_full';
  if (bet === null || !Number.isSafeInteger(bet) || bet <= 0) return 'invalid_bet';
  if (bet < table.minBet) return 'bet_too_small';
  if (bet > table.maxBet) return 'bet_too_large';
  return null;
}

export function addSeat(
  table: BlackjackTable,
  seat: { viewerUserId: string; displayName: string; bet: number },
): void {
  table.seats.push({ ...seat, hands: [] });
}

/** Removes a seat during the lobby, returning it (so its bet can be refunded) or null if there was none. */
export function removeSeat(table: BlackjackTable, viewerUserId: string): BlackjackSeat | null {
  if (table.phase !== 'lobby') return null;
  const index = findSeatIndex(table, viewerUserId);
  if (index === -1) return null;
  return table.seats.splice(index, 1)[0] ?? null;
}

function nextTurn(table: BlackjackTable): { seat: number; hand: number } | null {
  for (let seat = 0; seat < table.seats.length; seat += 1) {
    const hands = (table.seats[seat] as BlackjackSeat).hands;
    for (let hand = 0; hand < hands.length; hand += 1) {
      if (!(hands[hand] as BlackjackHand).done) return { seat, hand };
    }
  }
  return null;
}

/**
 * Deals the opening cards: one to each seat in order, one to the dealer, then a second round. Naturals are marked
 * done at once. If the dealer has a natural the hand is over before anyone acts (there is no insurance to offer).
 */
export function dealHand(table: BlackjackTable, shoe: Shoe): void {
  table.dealtFrom = { seed: shoe.seed, offset: shoe.dealt };
  for (const seat of table.seats) {
    seat.hands = [{ cards: [], stake: seat.bet, doubled: false, fromSplit: false, done: false }];
  }
  table.dealer = [];
  for (let round = 0; round < 2; round += 1) {
    for (const seat of table.seats) (seat.hands[0] as BlackjackHand).cards.push(drawCard(shoe));
    table.dealer.push(drawCard(shoe));
  }

  const dealerNatural = isNaturalBlackjack(table.dealer);
  for (const seat of table.seats) {
    const hand = seat.hands[0] as BlackjackHand;
    if (dealerNatural || isNaturalBlackjack(hand.cards)) hand.done = true;
  }
  table.phase = 'playing';
  table.turn = nextTurn(table);
}

export type PlayerAction = 'hit' | 'stand' | 'double' | 'split';

export type ActionProblem = 'not_playing' | 'not_seated' | 'not_your_turn' | 'cannot_double' | 'cannot_split';

export interface ActionCheck {
  problem: ActionProblem | null;
  /** Extra currency the action costs (the original bet again for a double or a split, otherwise 0). */
  cost: number;
}

function currentHand(table: BlackjackTable): { seat: BlackjackSeat; hand: BlackjackHand } | null {
  if (!table.turn) return null;
  const seat = table.seats[table.turn.seat];
  const hand = seat?.hands[table.turn.hand];
  return seat && hand ? { seat, hand } : null;
}

/** Whether `viewerUserId` may take `action` right now, and what it would cost. Changes nothing. */
export function checkAction(table: BlackjackTable, viewerUserId: string, action: PlayerAction): ActionCheck {
  if (table.phase !== 'playing') return { problem: 'not_playing', cost: 0 };
  if (findSeatIndex(table, viewerUserId) === -1) return { problem: 'not_seated', cost: 0 };
  const current = currentHand(table);
  if (!current || current.seat.viewerUserId !== viewerUserId) return { problem: 'not_your_turn', cost: 0 };

  if (action === 'double') {
    if (current.hand.cards.length !== 2 || current.hand.doubled) return { problem: 'cannot_double', cost: 0 };
    return { problem: null, cost: current.seat.bet };
  }
  if (action === 'split') {
    // Once only: a seat that has already split holds two hands.
    if (current.seat.hands.length !== 1 || !isPair(current.hand.cards))
      return { problem: 'cannot_split', cost: 0 };
    return { problem: null, cost: current.seat.bet };
  }
  return { problem: null, cost: 0 };
}

/**
 * Applies an action that `checkAction` has already allowed (and, for a double or split, that has been paid for).
 * Moves the turn on when the hand is finished.
 */
export function applyAction(table: BlackjackTable, shoe: Shoe, action: PlayerAction): void {
  const current = currentHand(table);
  if (!current) return;
  const { seat, hand } = current;

  if (action === 'stand') {
    hand.done = true;
  } else if (action === 'hit') {
    hand.cards.push(drawCard(shoe));
    if (handValue(hand.cards).total >= 21) hand.done = true;
  } else if (action === 'double') {
    hand.stake += seat.bet;
    hand.doubled = true;
    hand.cards.push(drawCard(shoe));
    hand.done = true;
  } else {
    const [first, second] = hand.cards as [Card, Card];
    const aces = rankOf(first) === 'A';
    const build = (card: Card): BlackjackHand => {
      const cards = [card, drawCard(shoe)];
      return {
        cards,
        stake: seat.bet,
        doubled: false,
        fromSplit: true,
        // Split aces get one card each and no more; any other split hand that lands on 21 is also finished.
        done: aces || handValue(cards).total >= 21,
      };
    };
    seat.hands = [build(first), build(second)];
  }

  table.turn = nextTurn(table);
}

/** The current turn ran out of time: that hand stands. */
export function timeOutTurn(table: BlackjackTable): void {
  const current = currentHand(table);
  if (current) current.hand.done = true;
  table.turn = nextTurn(table);
}

/**
 * Plays out the dealer's hand. The dealer only draws when it can change a result: if every player hand is bust
 * or a natural, the hole card is simply turned over.
 */
export function playDealer(table: BlackjackTable, shoe: Shoe): void {
  const anyLiveHand = table.seats.some((seat) =>
    seat.hands.some((hand) => !isBust(hand.cards) && !(isNaturalBlackjack(hand.cards) && !hand.fromSplit)),
  );
  if (!anyLiveHand) return;
  while (dealerShouldDraw(table.dealer)) table.dealer.push(drawCard(shoe));
}

export interface SeatResult {
  viewerUserId: string;
  displayName: string;
  /** Everything this seat put in across its hands (bet, plus doubles and a split). */
  staked: number;
  /** Everything going back to the wallet. */
  payout: number;
  hands: Array<{ cards: Card[]; total: number; stake: number; outcome: HandOutcome; payout: number }>;
}

/** Final results for every seat, against the dealer's finished hand. */
export function tableResults(table: BlackjackTable): SeatResult[] {
  return table.seats.map((seat) => {
    const hands = seat.hands.map((hand) => {
      const settled = settleHand({
        cards: hand.cards,
        stake: hand.stake,
        fromSplit: hand.fromSplit,
        dealer: table.dealer,
      });
      return {
        cards: hand.cards,
        total: handValue(hand.cards).total,
        stake: hand.stake,
        outcome: settled.outcome,
        payout: settled.payout,
      };
    });
    return {
      viewerUserId: seat.viewerUserId,
      displayName: seat.displayName,
      staked: hands.reduce((sum, hand) => sum + hand.stake, 0),
      payout: hands.reduce((sum, hand) => sum + hand.payout, 0),
      hands,
    };
  });
}

/** What each seat has paid in so far — what a cancelled table gives back. Before the deal that is the bet. */
export function stakesInPlay(
  table: BlackjackTable,
): Array<{ viewerUserId: string; displayName: string; amount: number }> {
  return table.seats.map((seat) => ({
    viewerUserId: seat.viewerUserId,
    displayName: seat.displayName,
    amount: seat.hands.length > 0 ? seat.hands.reduce((sum, hand) => sum + hand.stake, 0) : seat.bet,
  }));
}
