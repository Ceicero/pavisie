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
- Each viewer can use each game command once every 2 seconds per channel (`commandCooldownMs`); repeats inside
  the gap are dropped silently. It is per command, like the economy commands' cooldown, so `!join` then
  `!leave` or `!hit` then `!stand` is never blocked. The streamer and moderators are exempt. The gap is short
  because a player needs several `!hit`s in a 25-second turn.
- The streamer's currency symbol only reaches chat through `chatSafeSymbol`: letters, digits and symbols
  (emoji included) are kept; mentions, links, slash commands, line breaks and invisible characters are not.

## Operator recovery: Redis lost a table mid-hand

The table, and so the list of who is seated, lives only in Redis. Every bet is already in Postgres as a
`blackjack_bet` ledger row, but if Redis loses the table (a flush, a failover without persistence, an eviction)
before it settles, nothing refunds those bets automatically. Players lose their stakes until someone refunds
them by hand. A finished or cancelled table always leaves a `ChannelGameHand` row whose `id` is the table id,
so the stranded bets are the ones with no such row.

1. **Make sure the table is really gone.** The live table for a channel is the Redis key
   `pavisie:games:table:<broadcaster Twitch user id>`. If it exists and holds that table id, the table is
   still running (or will resume on the next bot start): do not refund it.
2. **List what is owed.** Bets are noted `bj:<table id>:<step>`, and lobby refunds (`!leave`) are
   `blackjack_push` rows with the same kind of note. Read-only:

   ```sql
   WITH bets AS (
     SELECT "economyId", split_part(note, ':', 2) AS table_id, "fromUserId" AS viewer, SUM(amount) AS bet
     FROM "ChannelTransaction"
     WHERE type = 'blackjack_bet' AND note LIKE 'bj:%'
     GROUP BY 1, 2, 3
   ), refunds AS (
     SELECT "economyId", split_part(note, ':', 2) AS table_id, "toUserId" AS viewer, SUM(amount) AS refunded
     FROM "ChannelTransaction"
     WHERE type = 'blackjack_push' AND note LIKE 'bj:%'
     GROUP BY 1, 2, 3
   )
   SELECT e."channelUserId" AS broadcaster, b.table_id, b.viewer, w."displayName",
          b.bet - COALESCE(r.refunded, 0) AS owed
   FROM bets b
   JOIN "ChannelEconomy" e ON e.id = b."economyId"
   LEFT JOIN refunds r USING ("economyId", table_id, viewer)
   LEFT JOIN "ChannelWallet" w ON w."economyId" = b."economyId" AND w."viewerUserId" = b.viewer
   WHERE NOT EXISTS (SELECT 1 FROM "ChannelGameHand" h WHERE h.id = b.table_id)
     -- Already refunded by hand in step 3 (the reason must be written exactly as shown there).
     AND NOT EXISTS (
       SELECT 1 FROM "ChannelTransaction" a
       WHERE a.type = 'admin_add' AND a."economyId" = b."economyId" AND a."toUserId" = b.viewer
         AND a.note = 'Blackjack refund, table ' || b.table_id
     )
     AND b.bet - COALESCE(r.refunded, 0) > 0
   ORDER BY broadcaster, b.table_id;
   ```

   `owed` includes extra stakes from doubles and splits. Whether the lost hand would have won is unknowable,
   so the fair outcome is to return every stake, which leaves both players and house where they started.

3. **Refund through the ledger, never by editing rows.** On the streamer's Currency page, add `owed` to each
   viewer with the reason written exactly as `Blackjack refund, table <table id>`. That writes an `admin_add` ledger row and
   updates the balance together. Do not insert `ChannelTransaction` rows or change `ChannelWallet.balance`
   directly: the two would drift apart.
4. **Tell the channel.** The bot cannot announce it, because it no longer knows the table existed.

Running the query again after step 3 lists only what is still owed, because it skips viewers who already have
an `admin_add` with that exact reason. Use one refund per viewer per table for the full `owed` amount.
