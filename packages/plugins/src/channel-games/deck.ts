// Playing cards, shared by every table game (blackjack now; hold'em later). A card is a two-character string,
// rank then suit ("AS", "TD", "9H"), so table state serialises to JSON for Redis without any conversion.
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'] as const;
export const SUITS = ['S', 'H', 'D', 'C'] as const;

export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
export type Card = `${Rank}${Suit}`;

/** One ordered 52-card deck. */
export function standardDeck(): Card[] {
  const cards: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) cards.push(`${rank}${suit}`);
  }
  return cards;
}

export function rankOf(card: Card): Rank {
  return card[0] as Rank;
}

const SUIT_SYMBOLS: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

/** How a card is shown in chat: "A♠", "10♦", "K♥". */
export function formatCard(card: Card): string {
  const rank = rankOf(card);
  return `${rank === 'T' ? '10' : rank}${SUIT_SYMBOLS[card[1] as Suit]}`;
}

export function formatCards(cards: readonly Card[]): string {
  return cards.map(formatCard).join(' ');
}
