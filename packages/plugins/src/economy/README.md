# Economy plugin (`economy`)

Optional virtual currency: balance, a daily reward with a streak bonus, giving between members, a leaderboard,
and admin balance adjustments. **Disabled by default.**

**Virtual points only. No purchase, no cash-out, no real-money value, no gambling.** This plugin never touches
Stripe or any payment processor, and no feature converts the currency to or from real money.

## Commands

| Command                                          | Description                                                                                    | Who        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------- |
| `/economy balance [user]`                        | Check a balance (default: your own)                                                            | Everyone   |
| `/economy daily`                                 | Claim your daily reward (20h cooldown, streak bonus for claiming within 48h of the last claim) | Everyone   |
| `/economy give <user> <amount>`                  | Give some of your balance to another member                                                    | Everyone   |
| `/economy leaderboard`                           | Show the top 10 balances                                                                       | Everyone   |
| `/economy config [...]`                          | View or change the currency name/symbol and reward amounts                                     | Moderator+ |
| `/economy admin add <user> <amount> [reason]`    | Add to a member's balance                                                                      | Moderator+ |
| `/economy admin remove <user> <amount> [reason]` | Remove from a member's balance (never below zero)                                              | Moderator+ |

## Config keys (`configSchema`)

```
currencyName        string   Display name, e.g. "Agis" (default: "Agis")
currencySymbol       string   Display symbol/emoji, e.g. "♦️" (default: "♦️")
dailyMinAmount        number  Minimum daily reward (default: 50)
dailyMaxAmount        number  Maximum daily reward (default: 150)
streakBonusPerDay     number  Bonus added per consecutive daily streak day (default: 10)
streakBonusMax        number  Cap on the streak bonus (default: 200)
giveMinAmount         number  Minimum /economy give amount (default: 1)
giveMaxAmount         number  Maximum /economy give amount (default: 100000)
```

There is no dedicated dashboard page for this plugin — its settings are edited through the plugin config drawer
on `/dashboard/[guildId]/plugins` (auto-generated from `configSchema`), same as any other plugin's config.

## Data model

- `EconomyAccount.balance` is a derived/cached total (`BigInt`), never edited without a matching
  `EconomyTransaction` row in the same database transaction.
- `EconomyTransaction` is an append-only ledger: every `daily`, `give`, `admin_add`, and `admin_remove` movement is
  recorded with its amount, type, and (for daily claims) the resulting streak count in `note`.
- The daily-claim streak is not stored as its own column — it's read back from the most recent `daily`
  transaction's `note` field (`{"streak": n}`) rather than a separate mutable counter, keeping the ledger the
  single source of truth for the account's history.

## Permissions

No Discord permissions or privileged intents are required — every economy interaction happens through slash
command replies.

## Privacy notes

Every balance change is recorded as an append-only transaction (who, amount, type, optional note); balances are
always a derived total, consistent with how money-adjacent bookkeeping is handled elsewhere in this project —
except this currency has no real-world value or exchange path.
