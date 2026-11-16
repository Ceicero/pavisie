# Raid mode (`raidmode`)

Detects a raid from join rate and account age, can lock the server's channels down, and puts back exactly what
it changed with one click. Off by default; each server turns it on and sets its own thresholds.

## How it works

- **Detection.** Every join adds the member to a sliding window in Redis. The window counts **distinct
  members**: a member leaving and rejoining inside the window is counted once, so a few accounts looping
  leave/join cannot fake a raid. An incident starts when, within `windowSeconds`, at least `joinThreshold`
  members join **and** at least `newAccountSharePct`% of them have accounts younger than `newAccountMaxAgeHours`.
  Two joins crossing the threshold together start one incident.
- **Alert.** One staff alert per incident in `alertChannelId`, edited every few seconds with the counts. It
  never names or mentions the joining members. Buttons: **Lock down now** while not locked, **Restore
  permissions** while anything is locked.
- **Lockdown.** Automatic when `dryRun` is off (queued as a job, never run inside the join handler); otherwise
  only when an admin presses **Lock down now** or runs `/raidmode lockdown`. It denies Send Messages, Send
  Messages in Threads, Create Public/Private Threads and Add Reactions to `@everyone` on text, announcement,
  forum, media, voice and stage channels, in sidebar order, at most 100 (any beyond are reported, not silently
  dropped). It skips the alert channel and channels `@everyone` cannot see anyway. Optionally it also raises the
  verification level and pauses invites; both need Manage Server, which is a manual grant, and are skipped
  without it.
- **Cooldown.** After an incident ends or a lockdown is restored, a new incident within
  `autoLockdownCooldownMinutes` only alerts; it never locks down automatically. An admin can still press **Lock
  down now**. This stops a handful of accounts from keeping a server closed by repeating a small raid.
- **Exact restore.** Before each change the previous state of those flags (allowed / denied / not set) is saved,
  plus whether the overwrite existed. **Restore permissions** (or `/raidmode restore`, which picks the newest
  incident that still has something locked) puts each flag back, and deletes the overwrite again if the lockdown
  created it and nothing else is on it. A channel an admin changed during the raid is left as it is and reported
  (`changed_by_admin`); so are a deleted channel (`channel_deleted`), a change that never landed
  (`not_applied`), a verification level someone changed, and invites someone resumed. A change Discord refuses
  is kept so pressing Restore again retries it.
- **Crash safety.** The incident is marked `LOCKING` before the first Discord edit, and each change is saved
  before it is made. Restore works from the outstanding saved changes whatever the incident's state says, so a
  restart or a failed final write part-way through a lockdown never strands locked channels.
- **One at a time.** Lockdown and restore take a per-server lease, and their final write is fenced on the
  lockdown state they expect, so two clicks (or a lockdown for a new incident while an older one is being
  restored) cannot both apply.
- **Never lifted automatically.** After `quietMinutes` with no join the incident is marked ended. If the
  lockdown is still on, staff get one reminder in the alert channel. Lifting it is always a person's decision.

## Cost on the join path

One Redis round trip per join (a Lua script that updates the window and, during an incident, the incident's
counters and queued scores). Database writes happen every 5 seconds in the incident's update job, in batches,
and Redis is only trimmed after the database committed them. `scripts/bench-automod-raid.ts --raid-mode` runs it
next to automod on the 50k-member raid benchmark (`--raid-mode-lockdown` also runs the automatic lockdown). It is
the regression gate for this plugin; it is not in CI, so run it before merging changes to the join path.

## Data kept

| What                                                                                      | Where                    | Kept                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Incident: counts, timestamps, thresholds, lockdown state, who locked/restored (staff ids) | `RaidModeIncident`       | Until the server's audit-log retention (`DataRetentionPolicy.auditLogDays`) after it ends, once nothing is left locked |
| Exactly what a lockdown changed (channel id, the role, previous flag states)              | `RaidModeLockdownChange` | Deleted once restored                                                                                                  |
| Medium/high-risk joins during a raid: member id, score 0–100, reason codes, join time     | `RaidModeRiskScore`      | Deleted 30 days after the incident ends                                                                                |

No usernames, avatars, invite codes, IP addresses or message content are stored. Low-risk joins are only
counted. Reason codes: `discord_spammer_flag`, `account_age_lt_1h`, `account_age_lt_1d`, `account_age_lt_7d`,
`default_avatar`, `numbered_username` (only the shape of the name is checked; the name is never stored).
"Alt" signals are heuristics about one account; raid mode never links accounts to each other.

An hourly maintenance job purges scores and expired incidents, and ends any incident still marked active long
after its last join (for example if its update job was lost), so the overview never shows a raid in progress
forever.

## Audit trail

Written in the same transaction as the change it records (the #34 pattern):

| Action                      | When                                  | Payload                                                                           |
| --------------------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| `raidmode.incident.start`   | An incident starts                    | thresholds, window counts, dry run, whether the cooldown suppressed auto-lockdown |
| `raidmode.incident.end`     | It goes quiet (or is closed as stale) | counts, lockdown state                                                            |
| `raidmode.lockdown.apply`   | Lockdown applied                      | actions; channels locked / already closed / not covered / failed                  |
| `raidmode.lockdown.restore` | Restore pressed                       | restored, skipped (channel + reason), failed                                      |
| `raidmode.scores.record`    | Each batch of scores written          | counts only, never member ids                                                     |
| `raidmode.scores.purge`     | Score retention purge                 | rows deleted                                                                      |
| `raidmode.incidents.purge`  | Incident retention purge              | rows deleted, retention days                                                      |

## Read API

- `GET /guilds/:guildId/threats/incidents`: raid mode incidents as `ThreatIncidentDto` (`@pavisie/types`
  threats.ts, unchanged): a `raid` incident per raid (`joinsFlagged`), plus a `lockdown` incident while a lockdown
  is on or after it was restored (`lockdownAction`). `ruleName` is "Raid mode"; there is no `ruleId`.
- `GET /guilds/:guildId/raid-mode/incidents/:incidentId/members?minRisk=medium|high&limit=≤50&cursor=…`: the
  per-member drill-down (`RaidModeRiskMemberDto`), on its own route so the overview stays counts-only.

## Config

| Key                           | Default | Meaning                                                                                                   |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `joinThreshold`               | 10      | Distinct members joining in the window that can start an incident (3–1000; at least 5 with auto-lockdown) |
| `windowSeconds`               | 30      | Window length (5–600)                                                                                     |
| `newAccountMaxAgeHours`       | 72      | "New account" age (1–2160)                                                                                |
| `newAccountSharePct`          | 50      | Share of new accounts needed (0–100; at least 20 with auto-lockdown)                                      |
| `quietMinutes`                | 5       | Quiet time before the incident is marked ended (1–240)                                                    |
| `autoLockdownCooldownMinutes` | 30      | After an end or restore, new incidents only alert for this long (0–1440)                                  |
| `alertChannelId`              | none    | Where the alert, buttons and reminder go (a Discord channel id)                                           |
| `dryRun`                      | true    | Detect and alert only; no automatic lockdown                                                              |
| `lockdownChannelIds`          | []      | Channels to lock (Discord ids); empty = every lockable channel the bot manages (max 100)                  |
| `raiseVerification`           | false   | Also raise the verification level (needs Manage Server)                                                   |
| `pauseInvites`                | false   | Also pause invites (needs Manage Server)                                                                  |

Needs the privileged Server Members intent (`guildMemberAdd`). Automod's own raid lockdown options are separate
and unchanged; use one or the other until they are merged in a later PR.
