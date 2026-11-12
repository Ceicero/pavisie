// Blackjack hand arithmetic and the payout table. Pure functions over cards and whole numbers.
import { rankOf, type Card } from '../deck';

export interface HandValue {
  total: number;
  /** True when an ace is being counted as 11. */
  soft: boolean;
}

function cardPoints(card: Card): number {
  const rank = rankOf(card);
  if (rank === 'A') return 11;
  if (rank === 'T' || rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank);
}

/** The best total for a hand: aces count 11 until that would bust, then 1. */
export function handValue(cards: readonly Card[]): HandValue {
  let total = 0;
  let softAces = 0;
  for (const card of cards) {
    total += cardPoints(card);
    if (rankOf(card) === 'A') softAces += 1;
  }
  while (total > 21 && softAces > 0) {
    total -= 10;
    softAces -= 1;
  }
  return { total, soft: softAces > 0 };
}

export function isBust(cards: readonly Card[]): boolean {
  return handValue(cards).total > 21;
}

/** A natural: 21 on the first two cards. A 21 made after a split is not a blackjack (see `settleHand`). */
export function isNaturalBlackjack(cards: readonly Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

/** A pair for splitting means two cards of the same rank (a king and a queen are not a pair here). */
export function isPair(cards: readonly Card[]): boolean {
  return cards.length === 2 && rankOf(cards[0] as Card) === rankOf(cards[1] as Card);
}

/** The dealer draws to 17 and stands on every 17, soft 17 included. */
export function dealerShouldDraw(cards: readonly Card[]): boolean {
  return handValue(cards).total < 17;
}

export type HandOutcome = 'blackjack' | 'win' | 'push' | 'lose' | 'bust';

export interface HandSettlement {
  outcome: HandOutcome;
  /** What goes back to the player's wallet: 0 for a loss, the stake for a push, stake plus winnings for a win. */
  payout: number;
}

/**
 * Settles one player hand against the dealer's final cards.
 *
 * `stake` is everything the player put on this hand (the bet, doubled if they doubled). A natural blackjack pays
 * 3:2; because the currency is whole numbers, the half unit on an odd bet is rounded down (a 25 bet wins 37).
 */
export function settleHand(input: {
  cards: readonly Card[];
  stake: number;
  fromSplit: boolean;
  dealer: readonly Card[];
}): HandSettlement {
  const { cards, stake, fromSplit, dealer } = input;
  const player = handValue(cards).total;
  if (player > 21) return { outcome: 'bust', payout: 0 };

  const playerNatural = !fromSplit && isNaturalBlackjack(cards);
  const dealerNatural = isNaturalBlackjack(dealer);
  if (playerNatural) {
    return dealerNatural
      ? { outcome: 'push', payout: stake }
      : { outcome: 'blackjack', payout: stake + Math.floor((stake * 3) / 2) };
  }
  if (dealerNatural) return { outcome: 'lose', payout: 0 };

  const dealerTotal = handValue(dealer).total;
  if (dealerTotal > 21 || player > dealerTotal) return { outcome: 'win', payout: stake * 2 };
  if (player === dealerTotal) return { outcome: 'push', payout: stake };
  return { outcome: 'lose', payout: 0 };
}
