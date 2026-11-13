import type { Card } from '../deck';
import type { Shoe } from '../blackjack/shoe';

/**
 * A shoe that deals exactly `cards`, in order, followed by plenty of harmless filler (so it never looks like the
 * cut card has come out). Deal order at a table is: one card to each seat, one to the dealer, then a second round.
 */
export function stackedShoe(cards: Card[], seed = 7): Shoe {
  const filler: Card[] = Array.from({ length: 200 }, () => '5C' as Card);
  return { seed, dealt: 0, cards: [...cards, ...filler] };
}
