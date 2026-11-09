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
| `/poll results <id>`                                                         | Show a poll's current results (ephemeral when the poll is anonymous)                                       | Everyone                                  |
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
| `/tag create <name> [content] [staff_only]`                                  | Create a tag; omit or leave `content` blank to open a modal with embed fields                              | Moderator+                                |
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

### Input checks

Whitespace-only text is rejected before anything is saved: a poll question, giveaway prize, suggestion,
announcement, reminder, or event title; a birthday announcement message; a tag trigger phrase; sticky text; an
auto-thread name or starter; and a stats-channel template. Poll options that repeat once case is ignored are
rejected. Giveaways and polls must stay open between 15 seconds and 28 days. One-off announcements, one-off
reminders, and event start times more than 30 seconds in the past are rejected. An event's end has to be after
its start. Recurring reminders are scheduled from their cron expression.

If posting or enqueueing fails, the new row is deleted: giveaways, events, suggestions, announcements, and
reminders. A giveaway or event also deletes the Discord message it already posted, and an event deletes the
native scheduled event when one was created with it. A suggestion deletes its post the same way. Discord
50001/50013 on a giveaway, event, or suggestion post is a permissions reply. Any other failure on those posts,
and a failed announcement or reminder save, asks for a retry. `/giveaway list`, `/announce list`, `/remind
list`, `/event list`, and `/suggestions list` say when there is nothing to show. A status filter that matches
nothing says that no suggestion has that status. `/poll results` on an anonymous poll is ephemeral (counts
only — see Privacy); a public poll's results are posted in the channel.

Birthday config, tags, stickies, channel automations, and stats channels use the same kind of reply. A channel
Discord reports as deleted (10003) is its own error. `/birthday config` separates that from a channel the bot
cannot post in, and rejects a deleted birthday role. `/birthday config-view` says when the announcement channel
was deleted and keeps the saved setting. `/birthday upcoming` with nobody registered says so. A birthday,
channel-automation, or stats config save that throws is an error reply. Tag, sticky, channel-automation, and
stats-channel replies are detailed in the sections below.

### Schedules

`/announce schedule` takes a cron expression (5 or 6 fields), an ISO date/time, or a duration such as `10m` or
`2h`. `/remind set` and `/event create` take an ISO date/time or a duration for the main time; a reminder's
`recurring` option is cron. A date/time with no zone is read in the guild timezone. `Z` or an explicit offset
such as `-04:00` is that exact instant. A local time that does not exist on a spring-forward day, or that
happens twice on a fall-back day, is rejected until the input includes an offset. A duration is an offset from
now.

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
- `/tag show` replies with an error on Discord 10003 (channel deleted) or 50001/50013 (missing access or
  permissions) and does not increment the use counter. Blank `content` on `/tag create` opens the editor modal.
  A blank trigger phrase, or a deleted or unusable trigger channel, is rejected. `/tag info` marks a trigger
  channel Discord says is gone and keeps the tag.

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
- `/channelauto publish add` and `/channelauto thread add` reject a deleted channel (10003) and a channel the
  bot cannot view. Missing Manage Messages or Create Public Threads still saves the rule and warns (the
  runtime fallbacks above). Both list subcommands drop channels Discord reports as deleted and say how many. A
  blank thread name or starter is rejected. Omitting the name keeps the current template, or `{user} — {date}`
  for a new rule; omitting the starter keeps the current one. A failed config save is an error reply.

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

`/statschannel create` makes a voice channel with `@everyone` denied Connect (visible, not joinable). If that
create hits Discord 50001/50013, the reply says Manage Channels is required; any other create failure asks for
a retry. If the channel is created and the config save then fails, the new channel is deleted. `/statschannel
add` rejects a deleted channel and a channel the bot cannot manage. `/statschannel list` names a deleted
counter and points at `/statschannel refresh` to drop it from config. An empty list says how to create one. If
a counter channel is deleted in Discord, the next refresh drops it from config (info log, no crash).

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

- `community:poll-end` — delayed, one per timed poll (`jobId poll-<id>`); closes the poll and renders final results. A closed poll names the single leading option, names a tie when several options share that count, or says there were no votes. Closing still completes when the original message was deleted (10008 — the results are posted as a new message in the channel). A missing channel or missing permission (10003/50001/50013) leaves the poll closed without a new post. A transient edit failure (network, 5xx) reopens a poll this run just closed and fails the job; `community:community-catchup` closes it again on a later pass.
- `community:giveaway-end` — delayed, one per giveaway (`jobId gw-<id>`); draws winners with `crypto.randomInt`, announces, and DMs them. Entries are unique per member. Zero entrants end with no winner. One entrant is drawn once, even when more winners were requested. `/giveaway reroll` draws only from entrants who have not already won and replaces the stored winners with that draw; when nobody new is left, the stored winners stay and nothing is announced. After the draw is saved, a later run announces those same winner ids and does not draw again. Once that announcement is recorded (Redis, 30 days) a further run does not announce again. A deleted original message (10008) still announces the winners. A missing channel or missing permission (10003/50001/50013) still DMs the winners when the guild can be reached, records the announcement, and completes the job. A transient send failure fails the job without drawing a new set; the winners already stored are what a later run announces.
- `community:announcement-run` — delayed for one-off announcements, or a repeatable scheduler for cron ones (`jobId ann-<id>`).
- `community:reminder-deliver` — delayed for one-off reminders, or a repeatable scheduler for recurring ones (`jobId rem-<id>`). A one-off is claimed with a conditional update (`delivered: false` → `true`) before it is sent, so this job and `community:reminder-sweep` cannot both deliver it; a retryable send clears that claim. A deleted channel or missing permission (10003/50001/50013) falls back to a DM. Recurring reminders stay `delivered: false`, so they remain on `/remind list`; a 30-second lock stops the same tick from sending twice.
- `community:reminder-sweep` — every 5 minutes; catches up any one-off reminder whose delayed job was lost, through the same claim-once delivery. Recurring reminders are not sent from this sweep. A recurring reminder whose scheduler is missing gets a new one on its cron expression in the guild timezone (UTC when that timezone cannot be read).
- `community:community-catchup` — every 5 minutes (job name `community-catchup`, queue `community.community-catchup`). Ends up to 50 giveaways and closes up to 50 polls that are still open with `endsAt` in the past, and sends event reminders that are at most 15 minutes late (up to 100 events that still have a channel). Ending, closing, and reminding go through the same actions as the delayed jobs, so the catch-up running beside a delayed job that still fires does not draw, close, or remind twice.
- `community:event-reminder` — delayed, one per configured reminder mark (`jobId ev-<id>-<minutes>`). A Redis flag per event and mark dedupes this job against `community:community-catchup`. A deleted channel or missing permission marks that reminder done. A transient failure leaves the flag unset so a later run can send it.
- `community:suggestion-sync` — every minute; reflects dashboard suggestion status/note edits into the posted Discord embed (dashboard writes only touch the database). A missing channel or guild (10003/10004) clears the stored message and thread ids; a missing message (10008) clears the stored message id. Missing access or permissions (50001/50013) keeps the ids and does not throw. A soft-deleted suggestion treats an already-deleted Discord message (10008) as success and clears the stored message id; a gone channel clears the thread id as well.
- `community:sticky-repost` — delayed catch-up re-post for a channel whose cooldown blocked an immediate one (`jobId sticky-<guildId>-<channelId>`, delay = the sticky's cooldown; enqueuing while one is pending is a no-op, so a burst of messages yields one re-post now and one after the cooldown).
- `community:stats-refresh` — every 5 minutes; renames each guild's stats channels at most once per `statsRefreshMinutes` (Redis `SET NX EX` gate per guild) and each individual channel at most once per 10 minutes (Redis `SET NX EX` gate per channel, since Discord's 2-renames/10-min limit is per channel; a 429 pushes that gate out to Discord's `retry_after`), concurrency 1, never throws. Skips unavailable (outage) guilds. A rename failing with 50013 Missing Permissions or 50001 Missing Access pauses the guild's automatic renames (one warn naming the guild) until its stats config or the bot's permissions on those channels change; `/statschannel refresh` still tries, and a successful rename lifts the pause.
- `community:birthday-announce` — hourly (top of the hour); for each available guild with birthdays enabled + a channel, when the guild-local hour equals `birthdays.announceHour`, posts one message per birthday due today (Feb 29 → Feb 28 in non-leap years; `lastAnnouncedYear IS NULL OR <> current year`, since a plain `NOT` would silently skip never-announced rows under Postgres NULL semantics), adds the optional role, and stamps `lastAnnouncedYear` so nothing is announced twice in a year. Members who left are skipped, not deleted.
- `community:birthday-role-remove` — delayed ~24h per birthday role grant (`jobId bday-role-<guild>-<user>-<year>`); removes the role if the member still has it.

## Sticky messages

`/sticky set` posts the sticky immediately. Whenever a member posts in that channel, the bot deletes its previous
copy and re-posts at the bottom — but never more than once per `cooldown` seconds (per channel, Redis
`SET NX EX`); a blocked re-post schedules the single `sticky-repost` catch-up job instead. Mentions are always
suppressed in the re-posted payload. If the channel is deleted, the sticky record is dropped automatically. If
the first post is rejected and the channel still exists, the row is kept and the reply says the next message
in the channel will try again. `/sticky list` drops stickies whose channels are gone and says how many.
`/sticky remove` still clears the row when the channel is already gone. A failure deleting the bot's previous
copy — including Discord 10008 (message already deleted), 10003 (channel gone), and 50001/50013 (missing access
or permission) — does not fail the removal.

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
