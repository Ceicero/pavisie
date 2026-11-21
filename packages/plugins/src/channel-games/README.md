# Channel games

Table games played in Twitch chat with a channel's own virtual currency (Agis by default). Phase 1 is
blackjack. Off by default: a streamer turns it on from the creator dashboard, under Currency.

The currency is virtual in both directions. It cannot be bought and cannot be cashed out.

## Playing blackjack

| Who             | Command                                           | What it does                                                         |
| --------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| Streamer or mod | `!bj start`                                       | Opens a table. The lobby stays open for 40 seconds.                  |
| Anyone          | `!bj join <bet>` (or `!join <bet>`, `!bet <bet>`) | Takes a seat. The bet is taken straight away.                        |
| Seated viewer   | `!leave`                                          | Leaves before the deal and gets the bet back.                        |
| Streamer or mod | `!bj deal`                                        | Deals now instead of waiting for the lobby timer.                    |
| Player on turn  | `!hit`, `!stand`, `!double`, `!split`             | Plays the hand. 25 seconds per turn, then the hand stands by itself. |
| Streamer or mod | `!bj stop`                                        | Cancels the table and returns every bet.                             |
| Anyone          | `!bj status`, `!bj`                               | Shows the table, or a one-line how-to.                               |

Every short form also works as `!bj <word>`, for example `!bj hit`.

Rules: up to 8 seats, six-deck shoe with a cut card, dealer stands on all 17s, blackjack pays 3:2 (a half
unit on an odd bet rounds down), a push returns the bet, double on any first two cards for one more card,
split a pair once. Split aces get one card each. No insurance or surrender.

## How it is built

| File                                       | Role                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `rng.ts`, `deck.ts`                        | Seeded injectable randomness and cards. Shared by every game.                                  |
| `blackjack/shoe.ts`, `hand.ts`, `table.ts` | The rules, as pure functions over plain data.                                                  |
| `blackjack/commands.ts`                    | Chat text to a command kind and a number. The only code that sees chat text.                   |
| `blackjack/messages.ts`                    | Every line a table says.                                                                       |
| `outbound.ts`                              | Per-channel coalescing send queue: one message a second, 500 characters. Shared by every game. |
| `host.ts`                                  | Runs tables: Redis state, timers, ledger calls.                                                |
| `chat.ts`                                  | Decides whether a chat message is a game command or should fall through.                       |

Currency only moves through `channel-economy/ledger.ts` (`debitChannel`, `settleChannelGameHand`).

## Things that must stay true

- Chat text is never logged, stored or repeated. Tables show display names and numbers only.
- Every balance change is a ledger row. Game transaction types are never "earned".
- A table survives a bot restart: it is read from Redis before every step.
- A hand is paid exactly once, whatever is interrupted.
- An existing custom command with the same name always wins.
