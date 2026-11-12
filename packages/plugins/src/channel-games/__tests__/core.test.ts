import { describe, expect, it } from 'vitest';
import { formatCard, formatCards, standardDeck, type Card } from '../deck';
import { createSeededRng, randomSeed, shuffled } from '../rng';
import { SHOE_CUT_REMAINING, SHOE_DECKS, createShoe, drawCard, needsReshuffle } from '../blackjack/shoe';
import {
  dealerShouldDraw,
  handValue,
  isBust,
  isNaturalBlackjack,
  isPair,
  settleHand,
} from '../blackjack/hand';

describe('seeded randomness', () => {
  it('gives the same sequence for the same seed and a different one for another seed', () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);
    const c = createSeededRng(43);
    const seqA = Array.from({ length: 20 }, () => a());
    expect(Array.from({ length: 20 }, () => b())).toEqual(seqA);
    expect(Array.from({ length: 20 }, () => c())).not.toEqual(seqA);
    expect(seqA.every((n) => n >= 0 && n < 1)).toBe(true);
  });

  it('shuffles without losing or inventing anything, and leaves the input alone', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const out = shuffled(input, createSeededRng(1));
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([...out].sort((x, y) => x - y)).toEqual(input);
    expect(out).not.toEqual(input);
  });

  it('accepts an injected rng, the same way rollDaily does', () => {
    // An rng that always returns 0 makes Fisher–Yates rotate predictably.
    expect(shuffled(['a', 'b', 'c'], () => 0)).toEqual(['b', 'c', 'a']);
  });

  it('produces 32-bit seeds', () => {
    for (let i = 0; i < 50; i += 1) {
      const seed = randomSeed();
      expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true);
    }
  });
});

describe('deck', () => {
  it('has 52 distinct cards', () => {
    const deck = standardDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
  });

  it('formats cards for chat', () => {
    expect(formatCard('AS')).toBe('A♠');
    expect(formatCard('TD')).toBe('10♦');
    expect(formatCards(['KH', '9C'])).toBe('K♥ 9♣');
  });
});

describe('shoe', () => {
  it('holds six full decks: every card exactly six times', () => {
    const shoe = createShoe(123);
    expect(shoe.cards).toHaveLength(52 * SHOE_DECKS);
    const counts = new Map<string, number>();
    for (const card of shoe.cards) counts.set(card, (counts.get(card) ?? 0) + 1);
    expect(counts.size).toBe(52);
    expect([...counts.values()].every((n) => n === SHOE_DECKS)).toBe(true);
  });

  it('is fully determined by its seed, so a hand can be replayed from seed and offset', () => {
    const first = createShoe(999);
    const dealt: Card[] = [];
    for (let i = 0; i < 30; i += 1) dealt.push(drawCard(first));
    expect(first.dealt).toBe(30);

    const replay = createShoe(999);
    expect(replay.cards.slice(0, 30)).toEqual(dealt);
    expect(createShoe(1000).cards).not.toEqual(createShoe(999).cards);
  });

  it('asks for a reshuffle only once the cut card is reached', () => {
    const shoe = createShoe(5);
    while (shoe.cards.length > SHOE_CUT_REMAINING) {
      expect(needsReshuffle(shoe)).toBe(false);
      drawCard(shoe);
    }
    expect(needsReshuffle(shoe)).toBe(false);
    drawCard(shoe);
    expect(needsReshuffle(shoe)).toBe(true);
  });

  it('leaves enough behind the cut card for a full table to finish any hand', () => {
    // Worst case: 8 seats all split (16 hands) and draw long, plus the dealer. 78 cards covers it.
    expect(SHOE_CUT_REMAINING).toBeGreaterThanOrEqual(16 * 4 + 10);
  });
});

describe('hand values', () => {
  it('counts aces as 11 until that would bust', () => {
    expect(handValue(['AS', '7D'])).toEqual({ total: 18, soft: true });
    expect(handValue(['AS', '7D', '9C'])).toEqual({ total: 17, soft: false });
    expect(handValue(['AS', 'AD'])).toEqual({ total: 12, soft: true });
    expect(handValue(['AS', 'AD', 'AC', '8H'])).toEqual({ total: 21, soft: true });
    expect(handValue(['KS', 'QD', '2C'])).toEqual({ total: 22, soft: false });
    expect(handValue(['TS', 'JD'])).toEqual({ total: 20, soft: false });
  });

  it('recognises a bust, a natural and a pair', () => {
    expect(isBust(['KS', 'QD', '2C'])).toBe(true);
    expect(isBust(['KS', 'AD'])).toBe(false);
    expect(isNaturalBlackjack(['AS', 'KD'])).toBe(true);
    expect(isNaturalBlackjack(['7S', '7D', '7C'])).toBe(false);
    expect(isPair(['8S', '8D'])).toBe(true);
    // Two ten-value cards of different rank are not a pair for splitting.
    expect(isPair(['KS', 'QD'])).toBe(false);
    expect(isPair(['8S', '8D', '2C'])).toBe(false);
  });

  it('has the dealer draw to 17 and stand on every 17, soft 17 included', () => {
    expect(dealerShouldDraw(['TS', '6D'])).toBe(true);
    expect(dealerShouldDraw(['TS', '7D'])).toBe(false);
    expect(dealerShouldDraw(['AS', '6D'])).toBe(false);
    expect(dealerShouldDraw(['AS', '5D'])).toBe(true);
  });
});

describe('payouts', () => {
  const settle = (cards: Card[], dealer: Card[], stake = 100, fromSplit = false) =>
    settleHand({ cards, stake, fromSplit, dealer });

  it('pays a blackjack 3:2', () => {
    expect(settle(['AS', 'KD'], ['TS', '9D'])).toEqual({ outcome: 'blackjack', payout: 250 });
  });

  it('rounds the half unit on an odd blackjack bet down', () => {
    expect(settle(['AS', 'KD'], ['TS', '9D'], 25)).toEqual({ outcome: 'blackjack', payout: 62 });
    expect(settle(['AS', 'KD'], ['TS', '9D'], 1)).toEqual({ outcome: 'blackjack', payout: 2 });
  });

  it('pays an ordinary win 1:1 and returns the bet on a push', () => {
    expect(settle(['TS', '9D'], ['TS', '8D'])).toEqual({ outcome: 'win', payout: 200 });
    expect(settle(['TS', '8D'], ['TS', '8C'])).toEqual({ outcome: 'push', payout: 100 });
    expect(settle(['TS', '7D'], ['TS', '8C'])).toEqual({ outcome: 'lose', payout: 0 });
  });

  it('pays every standing hand when the dealer busts, and nothing to a bust hand', () => {
    expect(settle(['TS', '2D'], ['TS', '6C', '9H'])).toEqual({ outcome: 'win', payout: 200 });
    // A player who busts loses even if the dealer busts too.
    expect(settle(['TS', '6D', '9C'], ['TS', '6C', '9H'])).toEqual({ outcome: 'bust', payout: 0 });
  });

  it('pushes blackjack against blackjack, and a dealer blackjack beats a three-card 21', () => {
    expect(settle(['AS', 'KD'], ['AH', 'QC'])).toEqual({ outcome: 'push', payout: 100 });
    expect(settle(['7S', '7D', '7C'], ['AH', 'QC'])).toEqual({ outcome: 'lose', payout: 0 });
  });

  it('treats 21 after a split as a normal win, not a blackjack', () => {
    expect(settle(['AS', 'KD'], ['TS', '9D'], 100, true)).toEqual({ outcome: 'win', payout: 200 });
    // ...and it loses to a dealer natural.
    expect(settle(['AS', 'KD'], ['AH', 'QC'], 100, true)).toEqual({ outcome: 'lose', payout: 0 });
  });

  it('settles a doubled stake on the doubled amount', () => {
    expect(settle(['5S', '6D', 'TC'], ['TS', '9D'], 200)).toEqual({ outcome: 'win', payout: 400 });
  });
});
