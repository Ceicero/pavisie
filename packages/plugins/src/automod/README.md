# Automod

Configurable automated moderation rules — spam, mentions, invites, scam links, word/regex filters, caps, repeated
characters, attachments, NSFW-channel enforcement, new-account restrictions, and raid detection — with per-rule and
guild-wide dry-run, exemptions, cooldowns, and a false-positive review queue. Plugin id: `automod`. Enabled by
default, with dry-run on by default (SPEC.md §C; ARCHITECTURE.md §7.1).

## What it does

Every enabled rule is evaluated (in priority order) against each new message (and edited messages, for
content-dependent rules) or each new member join. A match can trigger one or more configured actions — warn,
delete, timeout, quarantine, alert staff, or just log ("ignore") — unless the user/role/channel is exempt, the
rule is on cooldown for that user, or dry-run is on (guild-wide or per-rule), in which case the match is only
logged. A message is re-evaluated on edit whenever its text may have changed — Discord also fires `messageUpdate`
for embed unfurls and pins, and those are filtered out — window-backed rules are skipped on that re-check, and
each rule can only act once per message — so one violation never produces two punishments, two alerts, or two
review rows. Every match is
recorded as an `AutomodEvent`, which shows up in `/automod review` and the dashboard's review queue until a
moderator marks it **Confirm violation** or **False positive**.

Raid detection (`RAID_DETECTION`) never bans automatically. Beyond its own per-rule actions, a guild can configure
`raidLockdown` (`none` / `raise-verification` / `quarantine-new-joins`) as an additional guild-wide response to a
detected join burst.

## Rule types

| Type                 | What it checks                                                       | Needs Message Content intent? | Needs Guild Members intent? |
| -------------------- | -------------------------------------------------------------------- | ----------------------------- | --------------------------- |
| `MESSAGE_FREQUENCY`  | Too many messages in a time window                                   | No                            | No                          |
| `DUPLICATE_MESSAGES` | The same message repeated                                            | Yes                           | No                          |
| `MENTION_SPAM`       | Too many mentions in one message                                     | No                            | No                          |
| `INVITE_LINKS`       | Discord invite links not on the allow list                           | Yes                           | No                          |
| `SCAM_LINKS`         | Known scam/phishing domains and bait phrases                         | Yes                           | No                          |
| `REGEX_FILTER`       | A custom regex pattern (validated against catastrophic backtracking) | Yes                           | No                          |
| `WORD_FILTER`        | A configured word/phrase list                                        | Yes                           | No                          |
| `CAPS`               | Excessive uppercase ("shouting")                                     | Yes                           | No                          |
| `REPEATED_CHARS`     | A character repeated many times in a row                             | Yes                           | No                          |
| `ATTACHMENTS`        | Blocked file extensions / too many attachments                       | Yes                           | No                          |
| `NSFW_ENFORCEMENT`   | Keywords outside an NSFW-marked channel                              | No\*                          | No                          |
| `ACCOUNT_AGE`        | New accounts under a minimum age, on join                            | No                            | Yes                         |
| `RAID_DETECTION`     | A burst of joins within a time window                                | No                            | Yes                         |

Thresholds come in two flavours, and each rule's field label and match reason says which one it is:
`MESSAGE_FREQUENCY` and `ATTACHMENTS`' max-attachments are allowances ("Max … allowed" — they flag _above_ the
number), while `MENTION_SPAM`, `DUPLICATE_MESSAGES`, `CAPS`, `REPEATED_CHARS` and `RAID_DETECTION` are trigger
points ("… to flag" — they flag _at_ the number or more). The convention is written down once, in
`engine/types.ts`.

\* `NSFW_ENFORCEMENT` doesn't _require_ the Message Content intent to stay "active", but its keyword matching is a
no-op without it (Discord doesn't deliver message text to the bot otherwise).

A rule whose required privileged intent isn't enabled shows as **inactive: requires `<intent>`** in
`/automod rule list`, `/automod rule view`, `/automod status`, and the dashboard, rather than silently failing.

## Commands

All commands require at least `helper` staff level (or an equivalent Discord permission); `rule create/edit/
delete/toggle/dryrun` and `exempt add/remove` additionally require `moderator`; guild-wide `dryrun` requires
`admin`.

- `/automod rule create <type> <name> <action> [timeout_minutes]` — opens a form for the rule's type-specific settings
- `/automod rule list` — every rule, with status
- `/automod rule view <rule>` — full configuration
- `/automod rule edit <rule>` — opens a prefilled form for the type-specific settings
- `/automod rule delete <rule>` — soft-deletes, with confirmation
- `/automod rule toggle <rule>` — enable/disable
- `/automod rule dryrun <rule> <on|off>` — that one rule's dry-run flag (a rule acts only when this **and** the guild-wide switch are off)
- `/automod rule test <rule> <text>` — dry-runs the rule's evaluator against sample text, no action taken
- `/automod exempt add|remove <rule> <kind> [role|channel|user|domain]` — per-rule exemptions
- `/automod exempt list <rule>` — a rule's current exemptions
- `/automod dryrun <on|off>` — guild-wide dry-run switch (admin)
- `/automod review` — pending-event queue with **Confirm violation** / **False positive** buttons
- `/automod status` — dry-run state, rule health, recent activity

## Config keys (`/config set automod.<key>` or the dashboard)

| Key                   | Default        | Notes                                                                   |
| --------------------- | -------------- | ----------------------------------------------------------------------- |
| `dryRun`              | `true`         | Guild-wide; ORed with each rule's own `dryRun` (`/automod rule dryrun`) |
| `alertChannelId`      | `null`         | Where the "alert staff" action and review-queue embeds post             |
| `quarantineRoleId`    | `null`         | Role assigned by the "quarantine" action and raid lockdown              |
| `exemptStaff`         | `true`         | Members at/above `helper` staff level are exempt from every rule        |
| `defaultTimeoutMs`    | `600000` (10m) | Used when a "timeout" action doesn't specify its own duration           |
| `raidLockdown`        | `'none'`       | `none` / `raise-verification` / `quarantine-new-joins`                  |
| `raidLockdownMinutes` | `15`           | Duration of a `quarantine-new-joins` lockdown                           |

## Permissions (why, and fallback if missing)

| Permission                         | Feature                                           | Optional | Fallback                                      |
| ---------------------------------- | ------------------------------------------------- | -------- | --------------------------------------------- |
| View Channel                       | reading messages, posting alerts                  | No       | Rules never fire in that channel              |
| Send Messages                      | alert/review embeds                               | No       | Alerts fail to send; matches are still logged |
| Embed Links                        | alert/review embeds                               | No       | Alerts post as plain text                     |
| Manage Messages                    | the "delete" action                               | Yes      | Matches are logged, not deleted               |
| Timeout Members (Moderate Members) | the "timeout" action                              | Yes      | Matches are logged, not timed out             |
| Manage Roles                       | "quarantine" action + raid-lockdown quarantine    | Yes      | Logged, role not assigned                     |
| Manage Server                      | raising verification level during a raid lockdown | Yes      | That lockdown option is skipped               |

No privileged intent is required for the plugin to load — `MessageContent`/`GuildMembers` unlock the
content/member-dependent rule types above; without them, those specific rules show as inactive.

## Privacy

- A matched rule's excerpt is stored on its `AutomodEvent` only when the guild has enabled
  `GuildConfig.logMessageContent`; otherwise only metadata (rule, user, channel, action) is recorded.
- Content-dependent rules only evaluate message text when the Message Content intent is enabled.
- Regex filters are validated for catastrophic-backtracking risk before they can be saved (`validateUserRegex`),
  and matching always runs against truncated input (`safeTest`).
- Raid detection never bans automatically.
- `AutomodEvent` rows are purged per-guild by an hourly job, honoring `DataRetentionPolicy.automodEventDays`
  (default 90 days).

## Dashboard

`/dashboard/[guildId]/automod` — rule list with type badges and enabled/dry-run switches, a create/edit form
driven by the rule's type, an actions builder, an exemptions editor, a guild-wide dry-run banner, a review-queue
tab, and a settings tab.

## Performance under a raid

Every message and every join runs the guild's rules, so a raid multiplies whatever one evaluation costs. Three
things keep that cost low:

- **Rules are read once and reused for 2 seconds** (`RULE_CACHE_TTL_MS` in `service.ts`), already parsed. A
  change made with `/automod rule ...` or `/automod exempt ...` drops the cached copy and applies to the next
  event. A change made in the dashboard is written by the API process, which cannot reach the bot's cache, so
  it applies within 2 seconds.
- **Each sliding-window check is one Redis round trip** (`RedisWindowStore.pushAndCount` runs as a single
  `MULTI`/`EXEC`), which also makes the count atomic.
- **A word filter is compiled once per rule**, not once per message.

`scripts/bench-automod-raid.ts` reproduces the load: a 50,000-member server taking 400 messages and 150 joins a
second, against real Postgres and Redis with Discord faked in-process. It needs `DATABASE_URL` and `REDIS_URL`
(the same services CI and `docker-compose.yml` start), uses a fixed seed, and removes everything it writes.

```bash
# Load test: latency, backend calls per event, and where handlers wait
pnpm --filter @pavisie/plugins exec tsx scripts/bench-automod-raid.ts

# Twice the load
pnpm --filter @pavisie/plugins exec tsx scripts/bench-automod-raid.ts --msg-rate 800 --join-rate 300

# Behavior check: replays the raid one event at a time and prints a digest of every AutomodEvent written and
# every Discord call made. A performance change must leave this digest unchanged.
pnpm --filter @pavisie/plugins exec tsx scripts/bench-automod-raid.ts --mode verify --seconds 10 --discord-ms 0
```

Discord's rate limits are not simulated, so the latency of deletes and alerts is a best case. The numbers that
transfer between machines are the backend calls per event; latency and CPU depend on the hardware.
