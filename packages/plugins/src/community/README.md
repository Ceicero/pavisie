# Community plugin (`community`)

Polls, giveaways, a suggestion box, scheduled announcements, reminders, event RSVPs, tags (custom commands with
optional keyword auto-responders), sticky messages, channel automations (auto-publish for announcement channels,
one-thread-per-post auto-threads), server-stats counter channels, and opt-in birthday announcements. Enabled by
default.

## Commands

| Command                                                                      | Description                                                                                                | Who                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `/poll create`                                                               | Start a poll (2-10 options, optional duration/anonymous/multi-select)                                      | Everyone                                  |
| `/poll end <id>`                                                             | End a poll early                                                                                           | Poll creator or moderator+                |
| `/poll results <id>`                                                         | Show a poll's current results                                                                              | Everyone                                  |
| `/giveaway start`                                                            | Start a giveaway (prize, duration, winners, optional eligibility rules)                                    | Moderator+                                |
| `/giveaway end \| reroll \| list \| cancel`                                  | Manage giveaways                                                                                           | Moderator+                                |
| `/suggest <text>`                                                            | Submit a suggestion                                                                                        | Everyone                                  |
| `/suggestions setup`                                                         | Choose the suggestions channel                                                                             | Moderator+                                |
| `/suggestions status <number> <status> [note]`                               | Change a suggestion's status                                                                               | Moderator+                                |
| `/suggestions list [status]`                                                 | List suggestions                                                                                           | Moderator+                                |
| `/announce schedule <channel> <when> <message>`                              | Schedule an announcement (cron, ISO date/time, or duration)                                                | Moderator+                                |
| `/announce list \| cancel \| preview`                                        | Manage scheduled announcements                                                                             | Moderator+                                |
| `/remind set <when> <message> [channel] [recurring]`                         | Set a reminder (DM by default, or post in a channel)                                                       | Everyone                                  |
| `/remind list \| cancel`                                                     | Manage your reminders                                                                                      | Owner, or moderator+ to cancel others'    |
| `/event create`                                                              | Create an event with RSVP, optionally as a native Discord scheduled event                                  | Helper+                                   |
| `/event list \| cancel \| rsvps`                                             | Manage events                                                                                              | Helper+                                   |
| `/tag show <name> [ephemeral]`                                               | Post a tag (custom command); staff-only tags need helper+                                                  | Everyone                                  |
| `/tag list`                                                                  | List this server's tags (staff-only tags hidden from non-staff)                                            | Everyone                                  |
| `/tag create <name> [content] [staff_only]`                                  | Create a tag; omit `content` to open a modal with embed fields                                             | Moderator+                                |
| `/tag edit <name>`                                                           | Edit a tag's content / embed title / embed description in a modal                                          | Moderator+                                |
| `/tag delete <name>`                                                         | Delete a tag (confirmation prompt)                                                                         | Moderator+                                |
| `/tag trigger <name> <mode> [phrase] [channel]`                              | Set/clear a keyword auto-responder (exact / contains / starts_with)                                        | Admin                                     |
| `/tag info <name>`                                                           | Uses, trigger, channels, created/updated by                                                                | Helper+                                   |
| `/sticky set [channel] [content] [cooldown]`                                 | Keep a staff message at the bottom of a channel (no `content` → editor modal with embed title/description) | Moderator+                                |
| `/sticky remove [channel]`                                                   | Remove a channel's sticky (deletes the record and the bot's last post)                                     | Moderator+                                |
| `/sticky list`                                                               | List every sticky in the server with jump links                                                            | Moderator+                                |
| `/channelauto publish add \| remove \| list`                                 | Auto-publish every new message in an announcement channel                                                  | Admin+                                    |
| `/channelauto thread add \| remove \| list`                                  | One thread per post in a channel (template, archive, attachments-only, starter)                            | Admin+                                    |
| `/statschannel create <template> [category] [kind]`                          | Create a locked voice channel (or category) showing a live server count                                    | Admin (bot needs Manage Channels)         |
| `/statschannel add <channel> <template>`                                     | Attach an existing voice/category/text channel as a counter                                                | Admin                                     |
| `/statschannel remove <channel>`                                             | Stop updating a counter (config only — the channel is not deleted)                                         | Admin                                     |
| `/statschannel list`                                                         | Show counters, templates, current rendered value, last refresh                                             | Admin                                     |
| `/statschannel refresh`                                                      | Refresh every counter now (at most once per 5 minutes)                                                     | Admin                                     |
| `/statschannel interval <minutes>`                                           | Set the automatic refresh interval (10-1440 minutes)                                                       | Admin                                     |
| `/birthday set <month> <day> [user]`                                         | Share your birthday in this server (month + day only — never a year), or set one for another member        | Self: Everyone (or Admin if self-service is off); `user`: Admin |
| `/birthday remove [user]`                                                    | Delete your birthday from this server, or another member's                                                 | Self: Everyone (or Admin if self-service is off); `user`: Admin |
| `/birthday view [user]`                                                      | See your birthday, or another member's if the public list is on                                            | Everyone (others: public list or Helper+) |
| `/birthday upcoming [ephemeral]`                                             | Next 15 upcoming birthdays (ephemeral; staff may post it publicly)                                         | Everyone if public list, else Helper+     |
| `/birthday config <channel> [hour] [role] [message] [enabled] [public_list] [allow_self_service]` | Configure birthday announcements                                                      | Admin+                                    |
| `/birthday config-view`                                                      | Show birthday settings + how many members registered (count only)                                          | Moderator+                                |

## Config keys (`configSchema`)

```
suggestions.channelId        string|null   Channel suggestions are posted to (null = not set up)
suggestions.threads          boolean       Auto-create a discussion thread per suggestion (default: true)
suggestions.dmAuthorOnStatus boolean       DM the author when their suggestion's status changes (default: true)
giveaways.defaultWinners     number        Default winner count for /giveaway start (default: 1)
eventReminderMinutes         number[]      Minutes-before-start marks to remind RSVP'd members (default: [60, 10])
polls.maxOptions             number        Maximum options per poll, 2-10 (default: 10)
tags.enabled                 boolean       Turn the /tag commands on or off (default: true)
tags.maxTags                 number        Hard cap on tags per server, 1-500 (default: 200) — abuse guard, not a paywall
tags.triggersEnabled         boolean       Master switch for keyword auto-responders (default: false; needs Message Content intent)
tags.triggerCooldownSeconds  number        Minimum seconds between auto-responder replies per tag, 1-3600 (default: 15)
sticky.enabled               boolean       Re-post sticky messages when members post (default: true)
sticky.maxPerGuild           number        Maximum stickies per server, 1-100 (default: 25)
sticky.defaultCooldownSeconds number       Default minimum seconds between re-posts, 3-600 (default: 10)
autoPublish.channelIds       string[]      Announcement channels whose new messages are crossposted automatically (max 25)
autoPublish.includeBots      boolean       Also publish other bots'/webhooks' messages (default: false — humans + this bot only)
autoThreads[]                object[]      One rule per channel (max 25):
  .channelId                 string          Text or announcement channel
  .nameTemplate              string          Thread name; tokens {user} {user.tag} {server} {date} (default: "{user} — {date}", trimmed to 100)
  .archiveMinutes            60|1440|4320|10080  Auto-archive after inactivity (default: 1440)
  .requireAttachment         boolean         Only thread posts with an attachment/embed (default: false)
  .starterMessage            string|null     Optional bot message posted in each new thread, max 300 chars (default: null)
statsChannels                array         Up to 10 `{ channelId, template }` counters (default: [])
statsRefreshMinutes          number        Minutes between automatic counter refreshes, 10-1440 (default: 15)
birthdays.enabled            boolean       Birthday announcements + /birthday set on/off (default: false)
birthdays.channelId          string|null   Channel birthdays are announced in (default: null)
birthdays.message            string        Template; tokens {mention} {user} {server} (default: "🎂 Happy birthday, {mention}!")
birthdays.announceHour       number        Guild-local hour 0-23 to announce, using the core timezone (default: 9)
birthdays.roleId             string|null   Optional role added for ~24h on the day (default: null)
birthdays.publicList         boolean       Members may run /birthday upcoming and view each other's (default: true)
birthdays.allowSelfService   boolean       Members may set/remove their OWN birthday with /birthday set|remove (default: true). Orthogonal to `enabled` — when false, only an admin can set or remove a birthday (their own or another member's); `enabled:false` still blocks everything.
```

### Tags (custom commands / auto-responders)

- A tag is plain text (≤2000 chars) and/or a flat embed (title, description, color, image URL, footer). Content is
  rendered with the same fixed, non-recursive variable set as welcome messages — `{user}`, `{user.tag}`,
  `{user.id}`, `{server}`, `{memberCount}`, `{mention}` — and **nothing else is ever evaluated** (no scripting
  language, no nested tags). Unknown tokens are left as-is.
- Replies always use `allowedMentions: { parse: [] }`; the only mention a tag can produce is the invoker's own
  `{mention}`. Tags can never ping `@everyone`, `@here`, or roles.
- Names are 1-32 chars, lowercase `a-z0-9` plus `-`/`_`, unique per server.
- Auto-responders are opt-in per tag (`/tag trigger` or the dashboard) **and** per server (`tags.triggersEnabled`),
  and only run when the bot has the Message Content privileged intent. Without it `/tag show` still works, `/plugin
status community` reports the plugin as degraded, and triggers are simply inactive. Modes: `exact` (whole message
  equals the phrase), `contains` (phrase appears as a whole word), `starts_with`. Optional channel restriction;
  one reply per tag per `tags.triggerCooldownSeconds`.
- Every create/edit/delete (bot or dashboard) writes an audit row (`community.tag.create|update|delete`).

### Channel automations

- **Auto-publish** — every new message in a listed announcement channel is published (crossposted) to follower
  servers via `messageCreate` → `message.crosspost()`. Messages already published, and other bots'/webhooks'
  messages (unless `includeBots`), are skipped. Publishing other members' messages needs **Manage Messages** in
  that channel; without it only the bot's own posts are published. Discord caps publishing at 10 messages per
  hour per channel. Failures (missing permission, crosspost limit) are logged **once per hour per channel**
  (Redis `SET NX EX 3600`) to the bot log and, if the `logging` plugin is on, as a `bot.error` entry. Successful
  publishes bump a per-day Redis counter (`pavisie:community:autopublish-count:<guildId>:<YYYY-MM-DD>`, UTC)
  that the dashboard shows as "published today" (`GET /guilds/:guildId/community/channel-automations/stats`).
- **Auto-threads** — every human post in a listed text/announcement channel gets its own thread named from the
  template (`{user}` = display name, `{user.tag}`, `{server}`, `{date}` = YYYY-MM-DD; unknown tokens are left
  literal; trimmed to 100 chars). Bot posts, posts that already have a thread, and — with `requireAttachment` —
  text-only posts are skipped. Errors are logged once per hour per channel and never thrown.
- Neither feature reads or stores message content — only channel id, author id/bot flag, message flags, and
  whether attachments/embeds are present.

### Server-stats counter channels

Templates use a fixed token set — `{members}` (all), `{humans}`, `{bots}`, `{boosts}`, `{roles}`, `{channels}`,
`{date}` (YYYY-MM-DD in the guild timezone). Unknown tokens are rejected at command/dashboard time so a typo never
becomes a channel literally named "{memebrs}"; the rendered name is truncated to Discord's 100-character limit.

Constraints (also stated in the UI):

- **Discord allows 2 channel-name edits per 10 minutes per channel.** Counters therefore refresh on a schedule
  (`statsRefreshMinutes`, minimum 10) and `/statschannel refresh` is limited to once per 5 minutes; member
  join/leave events deliberately do _not_ trigger a rename.
- **`{online}` is not offered** — it needs the Presence privileged intent, which Pavisie does not enable. The
  command rejects it with that explanation.
- `{humans}`/`{bots}` need the Server Members intent; without it `{humans}` = `{members}` and `{bots}` = 0 (the
  reply says so).

`/statschannel create` makes a voice channel with `@everyone` denied Connect (visible, not joinable). If a counter
channel is deleted in Discord, the next refresh drops it from config (info log, no crash).

## Permissions

| Permission                             | Feature                                                                                 | Optional | Fallback                                                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send Messages                          | Posting polls/giveaways/suggestions/announcements/events, tag replies / auto-responders | No       | Command replies with an error                                                                                                                                                               |
| Embed Links                            | Result/status embeds                                                                    | No       | N/A                                                                                                                                                                                         |
| Manage Threads / Create Public Threads | Auto-threading suggestions, auto-threads                                                | Yes      | Suggestion/message still posts, no thread                                                                                                                                                   |
| Manage Messages                        | Auto-publish other members' announcement messages                                       | Yes      | Only the bot's own messages are published; warned once/hour                                                                                                                                 |
| Manage Events                          | Native Discord scheduled event for `/event create`                                      | Yes      | Event is still tracked and announced in-channel                                                                                                                                             |
| Manage Messages                        | Sticky messages (delete the bot's own previous sticky)                                  | Yes      | Old sticky stays in place; a new one is still posted (deleting the bot's own message doesn't strictly need it, but a channel overwrite can still remove it — `/permissions audit` explains) |
| Manage Channels                        | Server-stats counter channels (rename)                                                  | Yes      | Counters stop updating; `/statschannel refresh` reports the missing permission                                                                                                              |
| Manage Roles                           | Birthday role (optional)                                                                | Yes      | No role is added; the announcement still posts                                                                                                                                              |

Privileged intents: **Message Content — auto-responders only.** Everything else in the plugin (including `/tag
show`) works without it; the plugin degrades rather than disables when the intent is off.

## Privacy notes

- Poll votes, giveaway entries, suggestion votes, reminder text, and event RSVPs are stored for as long as the
  record exists, so results can be shown and re-rendered.
- **Anonymous polls never store or display who voted for which option** — only per-option counts are shown or
  returned by `/poll results`.
- Reminder message text is stored until it is delivered or cancelled.
- Tags store the text/embed staff wrote and a use counter. Auto-responder triggers compare incoming messages
  against your trigger phrases in memory only when the Message Content intent is enabled; the messages themselves
  are never stored (and never logged, even on error).
- **Sticky messages store only the text/embed staff wrote and the id of the bot's own last post.** The
  `messageCreate` handler never reads member message content — it only reacts to "a message was posted" in a
  channel that has a sticky (a Redis-cached channel set makes that check cheap for every other channel).
- Auto-publish and auto-threads act only on message ids/authors in the channels you list; content is never read
  or stored.
- Stats channels display only aggregate server counts (members, humans, bots, boosts, roles, channels); nothing
  per member is read or stored.
- **Birthdays store only the month and day** a member chooses to share, per server (`Birthday` row per
  guild/user), until the member removes it (`/birthday remove`), an admin removes it (`/birthday remove <user>`
  or the dashboard), or the server's data is deleted (cascade). No year, no age — there is no column for it. The
  bot never DMs about birthdays; announcements only ping the birthday member. Setting/removing your own birthday
  is **not** audited (no audit trail of personal data); config changes and admin removals are audited (admin
  removal records the user id only). An admin setting or removing a birthday **for another member**
  (`/birthday set|remove <user>`, gated by `allowSelfService`-independent admin checks) is a deliberate exception
  to that rule and **is** audited (`community.birthday.set` / `community.birthday.remove`) — user id only, never
  the month/day. Birthdays are included in the guild data export as `{ userId, month, day }`.

## Background jobs

- `community:poll-end` — delayed, one per timed poll (`jobId poll-<id>`); closes the poll and renders final results.
- `community:giveaway-end` — delayed, one per giveaway (`jobId gw-<id>`); draws winners with `crypto.randomInt`, announces, and DMs them.
- `community:announcement-run` — delayed for one-off announcements, or a repeatable scheduler for cron ones (`jobId ann-<id>`).
- `community:reminder-deliver` — delayed for one-off reminders, or a repeatable scheduler for recurring ones (`jobId rem-<id>`).
- `community:reminder-sweep` — every 5 minutes; catches up any one-off reminder whose delayed job was lost.
- `community:event-reminder` — delayed, one per configured reminder mark (`jobId ev-<id>-<minutes>`).
- `community:suggestion-sync` — every minute; reflects dashboard suggestion status/note edits into the posted Discord embed (dashboard writes only touch the database).
- `community:sticky-repost` — delayed catch-up re-post for a channel whose cooldown blocked an immediate one (`jobId sticky-<guildId>-<channelId>`, delay = the sticky's cooldown; enqueuing while one is pending is a no-op, so a burst of messages yields one re-post now and one after the cooldown).
- `community:stats-refresh` — every 5 minutes; renames each guild's stats channels at most once per `statsRefreshMinutes` (Redis `SET NX EX` gate per guild) and each individual channel at most once per 5 minutes (Redis `SET NX EX` gate per channel, since Discord's 2-renames/10-min limit is per channel), concurrency 1, never throws. Skips unavailable (outage) guilds.
- `community:birthday-announce` — hourly (top of the hour); for each available guild with birthdays enabled + a channel, when the guild-local hour equals `birthdays.announceHour`, posts one message per birthday due today (Feb 29 → Feb 28 in non-leap years; `lastAnnouncedYear IS NULL OR <> current year`, since a plain `NOT` would silently skip never-announced rows under Postgres NULL semantics), adds the optional role, and stamps `lastAnnouncedYear` so nothing is announced twice in a year. Members who left are skipped, not deleted.
- `community:birthday-role-remove` — delayed ~24h per birthday role grant (`jobId bday-role-<guild>-<user>-<year>`); removes the role if the member still has it.

## Sticky messages

`/sticky set` posts the sticky immediately. Whenever a member posts in that channel, the bot deletes its previous
copy and re-posts at the bottom — but never more than once per `cooldown` seconds (per channel, Redis
`SET NX EX`); a blocked re-post schedules the single `sticky-repost` catch-up job instead. Mentions are always
suppressed in the re-posted payload. If the channel is deleted, the sticky record is dropped automatically.

## Dashboard

`/dashboard/[guildId]/community` — Overview, Suggestions (status workflow), Giveaways, Polls (results bars),
Announcements, Events (RSVP counts), Tags (create/edit/delete tags, embed fields, staff-only, auto-responder
trigger + channels), Channels (sticky messages: channel, preview, cooldown, last re-post, Remove; auto-publish
channel list + "published today"; auto-thread rules with an inline editor; server-stats counters: attach, edit,
remove and refresh interval — new counters are created with `/statschannel create`), and Birthdays (settings,
count, next 10 upcoming by user id, admin removal) tabs. The API exposes only a birthday summary
(`GET /guilds/:guildId/community/birthdays/summary`), never a paginated table of every member's date. Tags API:
`GET/POST /guilds/:guildId/community/tags`, `PUT/DELETE .../tags/:tagId`. Removing a sticky from the dashboard
deletes the record and stops re-posts; the bot's last posted copy stays in Discord (the API has no gateway) — delete
it there or run `/sticky remove`. The Channels tab and the generic plugin config drawer edit the same
`autoPublish` / `autoThreads` / `statsChannels` keys.
