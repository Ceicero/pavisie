# `engagement` plugin

Leveling/XP with anti-farming controls, leaderboards, a reputation system, a starboard, and
temporary voice channels (SPEC.md §G subset; ARCHITECTURE.md §7.1 row `engagement`).

## What it does

### Leveling

- **Message XP**: `config.leveling.xpPerMessageMin`..`xpPerMessageMax` (default 15–25) per eligible
  message, gated by a per-user cooldown (`xpCooldownSeconds`, default 60s) and a rolling-hour cap
  (`maxXpPerHour`, default 600). Never reads message content — only that a non-bot, non-ignored
  message was sent. Ignores bots, `config.leveling.ignoredChannelIds`, and members with any role in
  `config.leveling.ignoredRoleIds`.
- **Voice XP**: `config.leveling.voiceXpPerMinute` (default 5) while a member is unmuted, undeafened,
  and non-bot in a voice channel that currently has at least 2 such members. Tracked via a Redis
  session timer per member (`voiceStateUpdate` starts/stops sessions as channel membership and
  mute state change) so partial minutes are never lost or double-counted.
- **Level formula**: `level(xp)` — cumulative XP to reach level `l` is
  `sum_{k=0}^{l-1} (5k² + 50k + 100)` (pure helpers `levelFromXp`/`xpForLevel`/`xpToNextLevel` in
  `service.ts`, unit tested for monotonicity and exact inverse behavior).
- **Level-up announcement**: `config.leveling.levelUpChannel` — `'current'` (the channel the
  triggering message/voice activity happened in), `'dm'`, `'none'`, or a channel id — using
  `config.leveling.levelUpMessage` (`{user}`/`{level}` placeholders). Settable from the dashboard or
  with `/level announce <mode> [channel]` (validates the bot can View Channel + Send Messages there
  before saving).
- **Level-role rewards** (`LevelReward`): recomputed whenever a member's stored level changes, up or
  down (message XP, voice XP, and `/level xp`). Announcements and the
  `level.up` event still fire only on a level-up. `config.leveling.rewardMode` — `'stack'` keeps every
  reward at or below the new level and removes reward roles above it; `'replace'` keeps only the single
  highest-earned reward role. `/level rewards sync` runs the same recompute for every ranked member
  (highest XP first, 500 per command). `/level reset` removes reward roles for up to 500 affected
  members, then deletes the matching profile rows.
- Dashboard XP adjustments enqueue `{guildId, userId}` on the Redis list `pavisie:engagement:reward-reconcile`
  when the stored level changes. `POST /guilds/:guildId/engagement/reset` only deletes profile rows and
  pushes the same entries (one member when `userId` is set, otherwise everyone who had a profile). The
  `engagement.reward-reconcile` job drains that list once a minute, 500 members per tick, and applies
  the same role sync. Roles update shortly after, not in the HTTP request.
- Emits the platform `level.up` event on every level-up (message or voice).

### Reputation

- `/rep give <user> [reason]` — 1 reputation per giver per cooldown window
  (`config.rep.cooldownHours`, default 24h; enforced by a Redis `SET NX PX` on the _giver_, which
  also guarantees "at most one rep to any single target per day from the same giver" whenever the
  cooldown is 24h or more). Can't self-rep.
- `/rep check [user]`, `/rep leaderboard`, `/rep revoke <user> <amount>` (admin — writes a negative
  `ReputationEvent`, never deletes history).

### Starboard

- `messageReactionAdd`/`Remove` (partials-aware) on `config.starboard.emoji` (default ⭐). Posts to
  `config.starboard.channelId` once eligible-reactor count reaches `config.starboard.threshold`
  (default 5), updates the embed as the count changes, and removes the post if it drops back below
  threshold. Self-stars excluded by default (`config.starboard.ignoreSelfStar`); NSFW channels
  skipped unless `config.starboard.allowNsfw`. Message content is only echoed into the embed when
  the Message Content privileged intent is enabled — otherwise the embed shows author, jump link,
  and attachment count only.

### Temporary voice channels

- `config.tempVoice.hubChannelIds` — joining a hub creates a personal voice channel (name from
  `config.tempVoice.nameTemplate`, `{user}` placeholder; under `config.tempVoice.categoryId` or the
  hub's own category) and moves the member in. `TempVoiceChannel` tracks ownership.
- Owner self-service: `/tempvoice lock|unlock|limit|rename|claim|kick|permit`.
- Cleanup: deleted immediately when empty (`voiceStateUpdate`), with `engagement:tempvoice-sweep`
  (every 5 minutes) as a backstop for anything a missed gateway event or bot restart leaves orphaned.

## Commands

| Command                                                                   | Notes                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/level rank [user]`                                                      | Public. Progress bar + rank position.                                                                                                                                   |
| `/level leaderboard [page]`                                               | Public, paginated (10/page) with Previous/Next buttons.                                                                                                                 |
| `/level config`                                                           | Moderator+. View-only.                                                                                                                                                  |
| `/level xp give\|remove\|set <user> <amount>`                             | Admin. Audited. `remove` and `set` recompute reward roles when the level changes. Announcements stay level-up only.                                                     |
| `/level rewards add\|remove\|list\|sync`                                  | Admin. `sync` recomputes rewards for every ranked member.                                                                                                               |
| `/level ignore add\|remove <channel\|role>`                               | Admin. Exactly one of channel/role per call.                                                                                                                            |
| `/level multiplier set\|clear <channel\|role>`                            | Admin. Exactly one of channel/role per call. `set` takes a factor; the highest role or channel factor wins (0.25–5×). A thread falls back to its parent channel.        |
| `/level announce <mode> [channel]`                                        | Admin. Sets `leveling.levelUpChannel` (same-channel/dm/off/a specific channel).                                                                                         |
| `/level reset <user?>`                                                    | Admin. Confirmation prompt (skipped if `fastActions` is on). Removes reward roles for up to 500 affected members, then deletes profiles. Omit `user` to reset everyone. |
| `/rep give\|check\|leaderboard`                                           | Public.                                                                                                                                                                 |
| `/rep revoke <user> <amount>`                                             | Admin.                                                                                                                                                                  |
| `/starboard set channel\|threshold\|emoji\|selfstar`, `/starboard status` | Admin (`ManageGuild`).                                                                                                                                                  |
| `/tempvoice setup <hub> [category] [name-template]`                       | Admin.                                                                                                                                                                  |
| `/tempvoice lock\|unlock\|limit\|rename\|claim\|kick\|permit`             | Anyone currently in their own temp channel.                                                                                                                             |

## Config keys

See `manifest.ts`'s `configSchema` for the full shape/defaults (`leveling`, `rep`, `starboard`,
`tempVoice`); every field has a default so `configSchema.parse({})` succeeds.

## Permissions

| Permission           | Feature                                        | Optional | Fallback                                                            |
| -------------------- | ---------------------------------------------- | -------- | ------------------------------------------------------------------- |
| Manage Roles         | Level-up role rewards                          | Yes      | Level-ups still announce; role grant/remove is skipped and logged.  |
| Manage Channels      | Temp voice channel create/rename/delete        | Yes      | Hub still exists; the bot can't create/manage the personal channel. |
| Move Members         | Moving the creator into their new temp channel | Yes      | Channel is still created; the member moves in manually.             |
| Send Messages        | Level-up announcements, starboard posts        | No       | Silently fails to send; nothing else breaks.                        |
| Embed Links          | Rank/leaderboard/starboard embeds              | No       | —                                                                   |
| Read Message History | Starboard reaction counts on older messages    | Yes      | May miss reactions added while the bot was offline.                 |

No privileged intents are required for the plugin to function; `MessageContent` (privileged, optional)
only upgrades the starboard embed to include a content excerpt when the guild has it enabled.

## Privacy

- Leveling stores aggregate counters only (XP, level, message count, voice minutes) — never message
  content.
- Reputation stores giver, recipient, an optional short free-text reason, and a timestamp.
- The starboard stores a link to the source message and its author; it echoes message content only
  when the Message Content intent is enabled, and only for messages members themselves starred.
- Temp voice stores the channel id, creator, and origin hub; deleted automatically once empty.

## Dashboard

`/dashboard/[guildId]/engagement` — four tabs (Leveling, Reputation, Starboard, Temp voice), all
built on `GET/PUT /guilds/:guildId/engagement/config` (one JSON blob covering every sub-feature's
settings) plus dedicated endpoints for the leaderboard, level-role rewards CRUD, an audited XP
adjustment, an audited guild-wide or per-member leveling reset, and the reputation leaderboard.
XP changes that move the stored level, and resets, enqueue reward-role reconciliation; the dashboard
tells admins that roles update shortly after, not instantly.

## Known gaps / follow-ups

- **No `ServiceMap['engagement']` entry**: `packages/plugins/src/sdk/services.ts` (owned by the SDK
  build stage) does not declare an `engagement` key, so this plugin does not call
  `ctx.services.register('engagement', ...)` — there is currently no cross-plugin consumer for one
  anyway. If a future plugin needs to call into engagement (e.g. automod granting/removing XP), add
  the key there first.
- **Role removal past the 500 cap**: `/level reset` and one reconcile-job tick each write roles for at
  most 500 members. A slash-command reset still deletes every matching profile, so members past that
  cap keep their reward roles — a later `/level rewards sync` only walks profiles that still exist.
  A dashboard reset enqueues every deleted member; the job continues on the next minute.
- **Temp voice category picker** in the dashboard has no server-side channel-type filter (no
  dedicated "categories only" endpoint), so it lists every channel; picking a non-category id fails
  the eventual Discord API call rather than being blocked in the UI.
