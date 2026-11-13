// The blackjack shoe: six decks shuffled together, dealt from the front, with a cut card. Once the cut card has
// been passed the current hand is finished from the same shoe and the next hand starts on a freshly shuffled one,
// exactly as at a real table. Plain data, so it lives in Redis between hands.
import { standardDeck, type Card } from '../deck';
import { createSeededRng, shuffled } from '../rng';

export const SHOE_DECKS = 6;
/** The cut card sits this many cards from the end: a new shoe is brought in once fewer than this remain. */
export const SHOE_CUT_REMAINING = 78;

export interface Shoe {
  /** The seed this shoe was shuffled from. With `dealt`, it identifies exactly which cards a hand was dealt. */
  seed: number;
  /** How many cards have been dealt from this shoe so far. */
  dealt: number;
  /** Cards still to be dealt, next card first. */
  cards: Card[];
}

export function createShoe(seed: number): Shoe {
  const cards: Card[] = [];
  for (let deck = 0; deck < SHOE_DECKS; deck += 1) cards.push(...standardDeck());
  return { seed, dealt: 0, cards: shuffled(cards, createSeededRng(seed)) };
}

/** True once the cut card has been reached: finish the current hand, then shuffle a new shoe. */
export function needsReshuffle(shoe: Shoe): boolean {
  return shoe.cards.length < SHOE_CUT_REMAINING;
}

/** Deals the next card. The cut card guarantees a hand can always be completed, so running dry is a bug. */
export function drawCard(shoe: Shoe): Card {
  const card = shoe.cards.shift();
  if (!card) throw new Error('blackjack: the shoe ran out of cards');
  shoe.dealt += 1;
  return card;
}
