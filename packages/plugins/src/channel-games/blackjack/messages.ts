// Every line the blackjack table says in chat. Pure formatting.
//
// Trust rule: the only viewer-derived text in any line is a display name that has been through
// `safeDisplayName`. Nothing a viewer typed is ever repeated. Every line starts with fixed text, so a name can
// never land at the start of a message where Twitch would read it as a chat command.
import { formatCard, formatCards, type Card } from '../deck';
import { handValue, isNaturalBlackjack, type HandOutcome } from './hand';
import type { BlackjackSeat, BlackjackTable, SeatResult } from './table';
import { MAX_SEATS } from './table';

const TAG = '🃏';

export function formatAmount(amount: number, symbol: string): string {
  return `${amount.toLocaleString('en-US')} ${symbol}`;
}

/** Names are capped again here so eight seats always fit comfortably in one 500-character message. */
function shortName(name: string): string {
  return name.length > 14 ? `${name.slice(0, 13)}…` : name;
}

function handText(cards: readonly Card[]): string {
  const value = handValue(cards);
  const label = isNaturalBlackjack(cards)
    ? 'BJ'
    : value.total > 21
      ? 'bust'
      : `${value.soft ? 'soft ' : ''}${value.total}`;
  return `${formatCards(cards)} (${label})`;
}

function seatText(seat: BlackjackSeat): string {
  return `${shortName(seat.displayName)}: ${seat.hands.map((hand) => handText(hand.cards)).join(' / ')}`;
}

export function lobbyOpened(table: BlackjackTable, prefix: string, seconds: number): string {
  return `${TAG} Blackjack table is open for ${seconds}s. Type ${prefix}bj join <bet> to sit down (bet ${formatAmount(table.minBet, table.currencySymbol)} to ${formatAmount(table.maxBet, table.currencySymbol)}, up to ${MAX_SEATS} seats).`;
}

export function lobbySeats(table: BlackjackTable): string {
  const seats = table.seats.map(
    (seat) => `${shortName(seat.displayName)} ${seat.bet.toLocaleString('en-US')}`,
  );
  return `${TAG} Seats ${table.seats.length}/${MAX_SEATS}: ${seats.length > 0 ? seats.join(', ') : 'none yet'}`;
}

export function lobbyClosedEmpty(): string {
  return `${TAG} Nobody sat down, so the blackjack table is closed.`;
}

export function dealt(table: BlackjackTable): string {
  const upcard = table.dealer[0] ? formatCard(table.dealer[0]) : '?';
  return `${TAG} Dealer shows ${upcard}. ${table.seats.map(seatText).join(' | ')}`;
}

export function turnPrompt(table: BlackjackTable, prefix: string, seconds: number): string | null {
  if (!table.turn) return null;
  const seat = table.seats[table.turn.seat];
  const hand = seat?.hands[table.turn.hand];
  if (!seat || !hand) return null;
  const which = seat.hands.length > 1 ? ` hand ${table.turn.hand + 1}` : '';
  const options = [`${prefix}hit`, `${prefix}stand`];
  if (hand.cards.length === 2 && !hand.doubled) options.push(`${prefix}double`);
  if (seat.hands.length === 1 && hand.cards.length === 2 && hand.cards[0]?.[0] === hand.cards[1]?.[0]) {
    options.push(`${prefix}split`);
  }
  return `${TAG} @${seat.displayName}${which}: ${handText(hand.cards)}. ${options.join(' ')} (${seconds}s)`;
}

/** A seat's cards after it acted, for the batched table update. */
export function seatUpdate(seat: BlackjackSeat): string {
  return `${TAG} ${seatText(seat)}`;
}

export function timedOut(seat: BlackjackSeat): string {
  return `${TAG} ${shortName(seat.displayName)} ran out of time and stands.`;
}

const OUTCOME_TEXT: Record<HandOutcome, string> = {
  blackjack: 'blackjack',
  win: 'win',
  push: 'push',
  lose: 'lose',
  bust: 'bust',
};

export function results(table: BlackjackTable, seatResults: readonly SeatResult[]): string {
  const dealerText = handText(table.dealer);
  const seats = seatResults.map((seat) => {
    const net = seat.payout - seat.staked;
    const outcomes = seat.hands.map((hand) => OUTCOME_TEXT[hand.outcome]).join('/');
    const amount = net === 0 ? '±0' : `${net > 0 ? '+' : '−'}${Math.abs(net).toLocaleString('en-US')}`;
    return `${shortName(seat.displayName)} ${outcomes} ${amount}`;
  });
  return `${TAG} Dealer: ${dealerText}. ${seats.join(' | ')} (${table.currencySymbol})`;
}

export function cancelled(): string {
  return `${TAG} The blackjack table was cancelled. Every bet has been returned.`;
}

export function resumed(): string {
  return `${TAG} The bot restarted. The blackjack table is back exactly where it was.`;
}

export function help(prefix: string): string {
  return `${TAG} Blackjack: a mod opens a table with ${prefix}bj start. Then ${prefix}bj join <bet>, and on your turn ${prefix}hit, ${prefix}stand, ${prefix}double or ${prefix}split. Blackjack pays 3:2.`;
}

export type NoticeKind =
  | 'mods_only'
  | 'table_exists'
  | 'no_table'
  | 'not_lobby'
  | 'already_seated'
  | 'table_full'
  | 'invalid_bet'
  | 'bet_too_small'
  | 'bet_too_large'
  | 'insufficient'
  | 'not_seated'
  | 'not_your_turn'
  | 'cannot_double'
  | 'cannot_split'
  | 'cannot_leave'
  | 'busy';

/** A short reply to one viewer. Fixed wording plus their display name and, for bets, the table's own limits. */
export function notice(
  kind: NoticeKind,
  displayName: string,
  table: Pick<BlackjackTable, 'minBet' | 'maxBet' | 'currencySymbol'> | null,
  prefix: string,
): string {
  const who = `@${displayName}`;
  const limits = table
    ? ` (${formatAmount(table.minBet, table.currencySymbol)} to ${formatAmount(table.maxBet, table.currencySymbol)})`
    : '';
  const text: Record<NoticeKind, string> = {
    mods_only: 'only the streamer or a mod can open or cancel a table.',
    table_exists: 'a blackjack table is already running.',
    no_table: `there is no blackjack table right now. A mod can open one with ${prefix}bj start.`,
    not_lobby: 'the hand has already started. Join the next table.',
    already_seated: 'you already have a seat.',
    table_full: 'the table is full.',
    invalid_bet: `say how much to bet as a whole number, like ${prefix}bj join 50${limits}.`,
    bet_too_small: `that bet is below the table minimum${limits}.`,
    bet_too_large: `that bet is above the table maximum${limits}.`,
    insufficient: "you don't have enough for that.",
    not_seated: "you're not seated at this table.",
    not_your_turn: "it isn't your turn.",
    cannot_double: 'you can only double on your first two cards.',
    cannot_split: 'you can only split a pair, once.',
    cannot_leave: 'you can only leave before the cards are dealt.',
    busy: 'the table is busy for a moment. Try again.',
  };
  return `${TAG} ${who}, ${text[kind]}`;
}
