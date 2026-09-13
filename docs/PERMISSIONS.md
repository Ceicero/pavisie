<!-- GENERATED FILE. Do not edit by hand — run `pnpm docs:permissions` (packages/plugins/scripts/export-permissions.ts), which renders this from every plugin's manifest.ts. CI fails if this file is stale. -->

# Permissions matrix

Every Discord permission Pavisie's plugins can use, why each one is needed, whether it's optional, and what
happens when it's missing. Generated from `packages/plugins/src/*/manifest.ts` via `allManifests` — this file
can never drift from what the bot actually declares. See also `/permissions audit` in Discord, which diffs this
same data against the bot's real permissions in your server.

The bot never requests **Administrator**. See "Invite permissions" below for the exact least-privilege set used
by the invite link the README and website generate.

## Permissions by plugin

### Admin (`admin`)

_Guided server setup, core configuration, plugin enable/disable, permission auditing, and bot health — the platform's always-on control plane._ (enabled by default, admin)

_No Discord permissions declared — every command replies over the interaction token and needs no channel-level permission._


### Moderation (`moderation`)

_Warnings, timeouts, kicks, bans, cases, and the moderator hierarchy — the platform's core moderation toolkit._ (enabled by default, moderation)

| Permission | Feature | Required? | Fallback if missing |
|---|---|---|---|
| Timeout Members | timeout / untimeout | Required | Timeout commands fail with a friendly error until granted. |
| Kick Members | kick / softban | Required | Kick and softban commands fail with a friendly error until granted. |
| Ban Members | ban / unban / softban | Required | Ban, unban, and softban commands fail with a friendly error until granted. |
| Manage Messages | purge | Required | /mod purge fails with a friendly error until granted. |
| Manage Channels | lock / unlock / slowmode | Required | Channel-lock commands fail with a friendly error until granted. |
| Manage Nicknames | nick | Required | /mod nick fails with a friendly error until granted. |
| Manage Roles | lock / unlock (channel overwrites), role add / remove | Required | /mod role and /mod lock\|unlock fail with a friendly error until granted. |
| Embed Links | mod-log and appeal embeds | Required | Mod-log posts fall back to plain text. |
| Read Message History | purge (fetching messages to delete) | Required | /mod purge fails with a friendly error until granted. |


### Automod (`automod`)

_Configurable automated moderation rules — spam, mentions, invites, scam links, word/regex filters, caps, raid detection — with per-rule dry-run, exemptions, and a false-positive review queue._ (enabled by default, moderation)

| Permission | Feature | Required? | Fallback if missing |
|---|---|---|---|
| View Channel | reading messages to evaluate rules, and posting alerts | Required | Automod cannot see messages in that channel; rules never fire there. |
| Send Messages | posting alert-staff embeds and the review queue | Required | Alert embeds fail to send; matches are still recorded and visible via /automod review and the dashboard. |
| Embed Links | alert and review-queue embeds | Required | Alerts post as plain text instead of embeds. |
| Manage Messages | the "delete" action | Optional | Matching messages are flagged/logged but not deleted. |
| Timeout Members | the "timeout" action | Optional | Matching users are flagged/logged but not timed out. |
| Manage Roles | the "quarantine" action and raid-lockdown quarantine | Optional | Quarantine actions are flagged/logged but the role is not assigned. |
| Manage Server | raising the verification level during a raid lockdown | Optional | "raise-verification" raid lockdown is skipped; the rule still alerts staff. |


### Enforcer (`enforcer`)

_Policy-driven, hands-off moderation: the bot flags possible violations from a server policy and a moderator decides — everything is bookkept in a read-only ledger and the database. Moderators never DM or confront the suspect directly; the bot mediates every action._ (disabled by default, moderation)

| Permission | Feature | Required? | Fallback if missing |
|---|---|---|---|
| View Channel | reading the ledger, flag-queue, and flagged channels | Required | Enforcer cannot read the channels it needs and will report itself unavailable. |
| Send Messages | posting ledger entries and flag-queue embeds | Required | Ledger entries and flag posts fail; `/enforcer setup` reports the missing permission. |
| Embed Links | ledger entries and flag-queue embeds | Required | Falls back to a much plainer message where possible. |
| Read Message History | "View context" (surrounding messages) on a flag | Required | Context snapshots and live context lookups are unavailable; only the flagged message itself (and its jump link) are shown. |
| Manage Channels | creating/repairing the ledger and flag-queue channels during `/enforcer setup` | Optional | You must create the channels yourself and pick them in the setup wizard; permission overwrites will not be applied automatically. |
| Manage Roles | creating the mute role and applying MUTE/UNMUTE decisions | Optional | The Mute decision is unavailable; you must create/assign a mute role manually. |
| Timeout Members | the Timeout decision (routed through the moderation plugin) | Optional | The Timeout decision is disabled in the flag-queue until this permission is granted. |
| Kick Members | the Kick decision | Optional | The Kick decision is disabled in the flag-queue until this permission is granted. |
| Ban Members | the Ban decision | Optional | The Ban decision is disabled in the flag-queue until this permission is granted. |


### Logging (`logging`)

_Routes member, message, role, channel, moderation, voice, and platform events to configured log channels, with redaction, retention, and a searchable dashboard audit log._ (enabled by default, moderation)

| Permission | Feature | Required? | Fallback if missing |
|---|---|---|---|
| View Channel | posting log embeds to configured log channels | Required | that channel is skipped and an error is logged |
| Send Messages | posting log embeds to configured log channels | Required | that channel is skipped and an error is logged |
| Embed Links | rich log embeds (title/fields/jump links) | Required | Discord blocks the send entirely, so the log embed is dropped |
| Read Message History | live message-edit/delete diffing and invite-use context | Optional | edits/deletes are still logged from cached data only |
| Manage Server | invite-use attribution on member join (`invite.use`) | Optional | member joins are still logged, just without which invite was used |


### Tickets (`tickets`)

_Button-driven support tickets with categories, staff assignment, tags, and HTML/JSON transcripts._ (disabled by default, community)

| Permission | Feature | Required? | Fallback if missing |
|---|---|---|---|
| Manage Channels | creating and deleting ticket channels (channel mode) | Optional | Channel-mode tickets fail with a clear ephemeral error when opened; thread-mode tickets still work. |
| Manage Roles | setting per-user/per-role permission overwrites on a new ticket channel | Optional | Channel-mode tickets fail with a clear ephemeral error when opened; thread-mode tickets still work. |
| Create Private Threads | creating private ticket threads (thread mode) | Optional | Thread-mode tickets fail with a clear ephemeral error when opened; channel-mode tickets still work. |
| Manage Threads | archiving and locking ticket threads on close, and adding participants to a thread | Optional | Thread-mode tickets close but the thread is left unarchived/unlocked for staff to close manually. |
| Send Messages | posting the panel, opening embed, and closing summary | Required | The plugin cannot function without this permission. |
| Embed Links | rich panel/ticket embeds | Optional | Falls back to plain-text messages. |
| Attach Files | delivering the HTML transcript file to the transcript channel/DM | Optional | The transcript is still saved and downloadable from the dashboard, just not attached in Discord. |
| Read Message History | building transcripts from the ticket channel/thread history | Optional | Transcripts record only the closing event, with no message history. |


### Roles & Onboarding (`roles`)

_Self-assignable role panels, welcome/goodbye messages, onboarding checklists, rules acknowledgement, and member verification (button, staff-approved modal, or CAPTCHA)._ (disabled by default, community)

| Permission | Feature | Required? | Fallback if missing |
|---|---|---|---|
| Manage Roles | role panels / verification / role persistence / auto-roles | Required | Role assignment fails with a clear error until Manage Roles is granted. |
| Send Messages | posting panels, welcome/goodbye, onboarding rules | Required | Messages cannot be posted to the configured channel. |
| Embed Links | panel / welcome / goodbye / onboarding embeds | Required | Falls back to plain text where possible. |
| Add Reactions | reaction-style role panels | Optional | Reaction panels cannot add the initial reactions; button/select panels are unaffected. |
| Manage Channels | account-age quarantine channel visibility (optional) | Optional | Quarantine still applies the role; channel overwrites are left as configured manually. |
| Kick Members | account-age gate: kick action | Optional | The kick action is skipped with a warning logged if this permission is missing. |


### Engagement (`engagement`)

_Leveling/XP with anti-farming controls, leaderboards, a reputation system, a starboard, and temporary voice channels._ (enabled by default, community)

| Permission | Feature | Required? | Fallback if missing |
|---|---|---|---|
| Manage Roles | level-up role rewards | Optional | Level-ups still announce; role rewards are skipped and logged. |
| Manage Channels | temporary voice channels | Optional | Members can still join a hub channel; the bot cannot create/rename/delete their temp channel. |
| Move Members | temporary voice channels (moving the creator into their new channel) | Optional | The temp channel is still created; the member has to move into it themselves. |
| Mute Members | temporary voice channels (owner can mute members in their own channel) | Optional | The temp voice owner cannot mute other members in their own channel; everything else still works. |
| Deafen Members | temporary voice channels (owner can deafen members in their own channel) | Optional | The temp voice owner cannot deafen other members in their own channel; everything else still works. |
| Send Messages | level-up announcements, starboard posts | Required | Announcements/starboard posts silently fail to send; nothing else is affected. |
| Embed Links | starboard posts, leaderboard/rank embeds | Required | Falls back to plain text where possible. |
| Read Message History | starboard (reading reaction counts on older messages) | Optional | Starboard may miss reactions added to messages the bot has not seen since restart. |


### Community (`community`)

_Polls, giveaways, suggestions, scheduled announcements, reminders, event RSVPs, tags (custom commands / auto-responders), sticky messages, and birthdays._ (enabled by default, community)

| Permission | Feature | Required? | Fallback if missing |
|---|---|---|---|
| Send Messages | posting polls/giveaways/suggestions/announcements/events/birthday announcements, tag replies / auto-responders | Required | The bot cannot post in the configured channel; the command replies with an error. |
| Embed Links | result, status, and birthday list embeds | Required | Falls back to plain text where possible. |
| Manage Threads | auto-threading suggestions, auto-threads | Optional | The suggestion/message is still posted; no thread is created. |
| Create Public Threads | auto-threading suggestions, auto-threads | Optional | The suggestion/message is still posted; no thread is created. |
| Manage Messages | auto-publish (crosspost announcement messages by other members) | Optional | Only the bot's own announcement messages get published; others are skipped and logged once per hour. |
| Manage Events | creating a native Discord scheduled event for /event create | Optional | The event is still tracked and announced in-channel; no Discord Events entry is created. |
| Manage Messages | sticky messages (delete the bot's own previous sticky) | Optional | The old sticky stays in place; the bot still posts a new one. |
| Manage Channels | server-stats counter channels (rename) | Optional | Counters stop updating; /statschannel refresh reports the missing permission. |
| Manage Roles | birthday role (optional) | Optional | No role is added; the announcement still posts. |


### Game Stats (`gamestats`)

_Per-guild leaderboards comparing members' game stats. Members opt in by linking their Steam account; stats are fetched from the public Steam Web API. Steam-only (no public API exists for console platforms) — first game: Dead by Daylight._ (disabled by default, community)

| Permission | Feature | Required? | Fallback if missing |
|---|---|---|---|
| Send Messages | stat card / leaderboard replies | Required | The command replies with an error instead of the stat card/leaderboard. |
| Embed Links | stat card / leaderboard embeds | Required | Falls back to plain text where possible. |


### Economy (`economy`)

_Optional virtual currency: balance, daily rewards with a streak bonus, giving between members, and a leaderboard. Virtual points only — no purchase, no cash-out, no gambling. Disabled by default._ (disabled by default, community)

_No Discord permissions declared — every command replies over the interaction token and needs no channel-level permission._


### Utility (`utility`)

_General-purpose utility commands: user/server info, timestamps, an embed builder, AFK, translation, weather, and bot health._ (enabled by default, utility)

| Permission | Feature | Required? | Fallback if missing |
|---|---|---|---|
| View Channel | help / userinfo / serverinfo / avatar / banner / roleinfo / channelinfo / timestamp / timezone / calculator / afk / translate / weather / status | Required | Interaction responses are delivered over the interaction token, so no channel-level permission is required for these read-only commands. |
| Embed Links | Rich embeds in command replies | Optional | Without Embed Links the bot can still reply, but Discord may render embeds as plain links in some contexts. |
| Manage Messages | /embed builder (send to channel) | Required | The command is hidden from members without Manage Messages by default (setDefaultMemberPermissions); "Send to channel" additionally checks the bot can send/embed in the target channel. |


### Music & Media (`media`)

_Playlist and queue management for a legal, user-authorized audio source. Unavailable unless MEDIA_PROVIDER names a compliant provider — no YouTube scraping, stream ripping, or copyright bypassing._ (disabled by default, media)

_No Discord permissions declared — every command replies over the interaction token and needs no channel-level permission._


### Integrations (`integrations`)

_Secure connector framework for optional external services: Twitch, YouTube, Instagram, Reddit, Steam, Google/Microsoft Calendar, and generic webhooks._ (disabled by default, integrations)

| Permission | Feature | Required? | Fallback if missing |
|---|---|---|---|
| View Channel | posting alerts / inbound webhook events | Required | Alerts silently fail to post in that channel; connection health shows an error. |
| Send Messages | posting alerts / inbound webhook events | Required | Alerts silently fail to post in that channel; connection health shows an error. |
| Embed Links | alert embeds (Twitch/YouTube/Instagram/Reddit/Steam/Calendar) | Optional | Alerts post as plain text instead of a rich embed. |


### AI Assistant (`ai`)

_Optional, disabled-by-default AI helper (/ask, /summarize, /draft, /mod-assist, @mention chat) with per-server opt-in, per-channel allowlisting, cooldowns, and token budgets._ (disabled by default, ai)

_No Discord permissions declared — every command replies over the interaction token and needs no channel-level permission._


## Privileged intents

Discord gates a few event categories behind "privileged intents" that must be turned on for the bot application
in the [Discord Developer Portal](https://discord.com/developers/applications) (Bot tab → Privileged Gateway
Intents) **and** in Pavisie's own `.env` (`ENABLE_MESSAGE_CONTENT_INTENT`, `ENABLE_GUILD_MEMBERS_INTENT`,
`ENABLE_GUILD_PRESENCES_INTENT`) before the features that need them come alive. Every plugin below degrades
gracefully (never crashes, never silently misbehaves) when a privileged intent it lists is off — see each row for
exactly what stops working.

Message Content additionally requires Discord's own approval once your bot is in 100+ servers ("Message Content
Intent" eligibility in the Developer Portal) — see the README's Discord Developer Portal setup section.

### GuildMembers

| Plugin | What degrades without it |
|---|---|
| Automod (`automod`) | The account-age gate and raid (join-burst) detection rules cannot evaluate and show as inactive. |
| Logging (`logging`) | Member join/leave logs and invite-use attribution on join are unavailable. |
| Roles & Onboarding (`roles`) | Welcome/goodbye messages, the account-age gate, membership screening, and role persistence on rejoin cannot function — the bot is not told about join/leave events. |

### MessageContent

| Plugin | What degrades without it |
|---|---|
| Automod (`automod`) | Content-dependent rules (duplicate messages, invite links, scam links, regex/word filters, caps, repeated characters, attachments) show as inactive instead of evaluating; join-based rules are unaffected. |
| Enforcer (`enforcer`) | Automatic flagging (matching messages as they are sent) is unavailable. Enforcer still works fully in manual mode — the "Flag for review" context menu and `/enforcer flag` always have the message content available regardless of this intent. |
| Logging (`logging`) | Message edit/delete logs still fire, but record metadata (author, channel, time) only — never the before/after text. |
| Tickets (`tickets`) | Transcripts still record who said something and when, but not the message text itself. |
| Engagement (`engagement`) | Leveling, XP, and reputation are unaffected (message events fire regardless of content). Only the starboard's message-content preview in its embed is unavailable and falls back to a jump link. |
| Community (`community`) | _(see the plugin README for what degrades without this intent)_ |
| AI Assistant (`ai`) | _(see the plugin README for what degrades without this intent)_ |

## Invite permissions

Permission integer: `1504210971862`

Scopes: `bot`, `applications.commands`

Example invite URL: `https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=1504210971862`

Permissions included (never Administrator):

- Kick Members
- Ban Members
- Manage Channels
- Add Reactions
- View Audit Log
- View Channel
- Send Messages
- Manage Messages
- Embed Links
- Attach Files
- Read Message History
- Use External Emoji
- Connect
- Speak
- Mute Members
- Deafen Members
- Move Members
- Manage Nicknames
- Manage Roles
- Manage Webhooks
- Manage Events
- Manage Threads
- Create Public Threads
- Create Private Threads
- Send Messages in Threads
- Timeout Members
