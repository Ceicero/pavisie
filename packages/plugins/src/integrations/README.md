# integrations

Secure connector framework for optional external services (SPEC.md §J). Disabled by default. Every connector
degrades independently when its env vars are unset — the plugin itself never becomes unavailable.

## What it does

- **Alert watchers** (poll on a cron, one Discord channel + optional role per watched target):
  - **Twitch** — `stream.online` alerts. Uses EventSub (webhook push, near-instant) when `PUBLIC_WEBHOOK_BASE_URL`
    and `TWITCH_EVENTSUB_SECRET` are set, else falls back to polling Helix `GET /streams` every 2 minutes.
  - **YouTube** — new upload alerts, polling the channel's uploads playlist every 10 minutes.
  - **Reddit** — new post alerts for a subreddit's `/new` feed every 5 minutes, with an NSFW filter.
  - **Steam** — app news alerts every 30 minutes.
- **Calendar reminders** — Google Calendar / Microsoft 365 Calendar, OAuth-authorized from the dashboard, polling
  upcoming events every 15 minutes.
- **Instagram** — new-post alerts for the OAuth-authorized account's own media only (Meta removed
  arbitrary-username lookup with the Basic Display API in Dec 2024), polling `graph.instagram.com/me/media`
  every 15 minutes, skipping the entire back catalogue on the first poll via a `lastSeenTimestamp` watermark.
- **Generic webhook** — inbound (templated Discord message from any JSON payload) and **outbound** (POST a signed
  JSON payload to any HTTPS URL on selected platform events: `moderation.caseCreated`, `ticket.opened`,
  `ticket.closed`, `member.verified`, `level.up`, `automod.triggered`, `enforcer.decided`).
- **GitHub** — removed 2026-09-02; retained only as a legacy no-op. New inbound endpoints are always issued a
  `/webhooks/generic/…` URL (`webhookPathFor`, `routes/integrations.ts`), so a working GitHub webhook URL can no
  longer be handed out. The `/webhooks/github/:endpointId` route still verifies signatures and returns 202 so
  pre-existing endpoints don't start erroring, but there is no longer a `github` provider to handle the result —
  `jobs/inbound.ts` logs "inbound event for a provider with no handleInbound" and drops it.

## Twitch chat bot

Pavisie joining a streamer's Twitch chat to answer commands — a distinct feature from the Twitch stream-live
alert watcher above, sharing only the `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` env vars. Lives in
`twitch-chat/` (`helix.ts`, `socket.ts`, `manager.ts`, `engine.ts`, `timers.ts`) + the `twitch-chat-tick` job.
See `docs/ARCHITECTURE.md` §19a for the full runtime contract.

- **How it works**: Pavisie runs as ONE dedicated Twitch bot account, authorized once by Brandon (owner-only
  `POST /owner/twitch-bot/connect`, `routes/twitch-bot.ts`). A streamer links their channel from the dashboard's
  "Twitch chat" tab (`POST /:guildId/integrations/twitch-chat/connect`, OAuth scope `channel:bot`). Chat
  messages arrive over the official EventSub WebSocket (`channel.chat.message` v1, Node 22's built-in global
  `WebSocket` — no new dependency); replies go out through Helix "Send Chat Message". All chat reads/sends run
  on the bot identity's token, never the broadcaster's.
- **Features**: per-channel custom `!commands` (name, response with `{user}`/`{channel}` placeholders, cooldown,
  minimum chat level everyone/subscriber/vip/moderator/broadcaster), recurring timers, and built-ins
  `!commands`/`!uptime`/`!title`. Configured from `/twitch` or the dashboard's Twitch chat tab (max 50 commands
  and 10 timers per channel).
- **What is stored**: the bot identity's and each linked channel's OAuth tokens (encrypted, same as every other
  connection), and the command/timer definitions themselves (name, response text, cooldown, level, interval).
- **What is NOT stored**: chat message content or chatter identity. Messages are parsed **in memory only**, to
  match a command, and are never written to a database row, a log line, or Discord. No Twitch-side moderation
  actions (ban/timeout/delete) ship in v1 — no moderator scopes are requested.
- **Degradation**: with `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` unset, or before Brandon authorizes the bot
  account, the feature reports itself as not configured (`/twitch status`, the dashboard tab, and this plugin's
  `health()`) instead of failing silently or erroring.

## Twitch channel-point rewards

A viewer redeeming a Twitch channel-point reward can trigger an action in Pavisie. Lives in `twitch-chat/`
(`rewards.ts`, `tts.ts`, `broadcaster-token.ts`, `manager.ts`) with overlay routes in `apps/api`. Shares the
same `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` vars and EventSub socket as the chat bot above. See
`docs/ARCHITECTURE.md` §19b for the full runtime contract.

- **How it works**: a streamer enables rewards on a linked channel and grants `channel:read:redemptions` scope
  (must re-link — existing channels have only `channel:bot`). When a viewer redeems the reward in chat, Pavisie
  matches it against configured `TwitchChatReward` rows by reward title or id, applies per-reward cooldowns, and
  runs the configured action. Four action kinds: SOUND (play an audio URL on the overlay), TTS (speak text via
  server-side synthesis on the overlay), CHAT (post to Twitch chat), DISCORD (post to a Discord channel). Text
  templates support `{user}`, `{input}` (viewer's text), and `{reward}` — no other interpolation.
- **Overlay**: served at `/overlay/:token` (the token is a capability — treat the URL like a password; it can
  be regenerated without re-linking). An HTML page held open by Server-Sent Events, with a queue of SOUND/TTS
  actions playing in sequence. Dedupes by action id so reconnects don't replay. Volume is clamped 0-100.
  Strict CSP (`default-src: none`), no user input, no attack surface — serves "link expired" on bad token.
- **TTS synthesis**: OBS's embedded browser has no `speechSynthesis` API, so synthesis is server-side via
  OpenAI's `/v1/audio/speech`. Uses the **guild's own configured OpenAI key** (same key as the `ai` plugin),
  trying `gpt-4o-mini-tts` then falling back to `tts-1`. Returns `null` (never throws) when: the guild has no
  OpenAI key, the provider is not OpenAI (e.g. Anthropic), or the request fails. Actions are logged and skipped,
  reported honestly to admins.
- **Sound effects**: admin-supplied public HTTPS URLs, validated by the existing SSRF guard at write time. No
  file upload or blob storage — the platform has no place to store arbitrary audio.
- **Commands**: `/twitch reward add|remove|list` (staff level admin). Add requires: reward title, action kind,
  and action-specific fields (soundUrl for SOUND, text template for TTS/CHAT/DISCORD, Discord channel for
  DISCORD). Dashboard "Rewards" tab has a "List rewards from Twitch" picker to auto-populate reward ids.
- **What is stored**: the OAuth tokens (broadcaster's, encrypted, same as every other connection), and the
  reward row (title, id, action, payloads, cooldown). Max 25 rewards per channel.
- **What is NOT stored**: viewer reward-input text, redeemer display name, or any redemption event detail beyond
  the reward title and action kind (in logs). Same privacy stance as chat message handling.
- **Degradation**: without `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`, or if the broadcaster's token lacks
  `channel:read:redemptions`, rewards don't function. The channel's `lastError` reports the scope gap plainly.
  With an invalid soundUrl or Discord channel id, that action is skipped (logged), while others run. With no
  OpenAI key, TTS actions are skipped; other reward types still work. No silent failures — admins know what's
  working and what isn't from `/twitch status` or the dashboard.

## Commands

`/integration connect <provider> [target] [channel] [role] [template]` — OAuth providers reply with a dashboard
link (OAuth must start from a signed-in dashboard session); apikey/public providers (YouTube, Steam) create the
connection immediately if `target`+`channel` are given.
`/integration disconnect <connection>` · `/integration status [connection]` · `/integration list`
`/integration alerts add|remove|list` — Twitch/YouTube/Reddit/Steam watch targets (one `IntegrationConnection` row
per target).
`/integration webhook create|list|delete` — inbound endpoints; the secret is shown exactly once, at creation.
`/integration outbound create|list|delete|test` — outbound endpoints.
`/twitch status|setup|off`, `/twitch command add|remove|list`, `/twitch timer add|remove|list` — the Twitch chat
bot, above.
`/twitch reward add|remove|list` — channel-point reward actions, above.

## Config keys

No per-guild plugin config — every setting lives on the `IntegrationConnection` (per-watch-target) or
`WebhookEndpoint` (per inbound/outbound endpoint) rows, both created/edited through the commands and API above.

## Permissions

`ViewChannel`/`SendMessages` (post alerts and inbound webhook events — required), `EmbedLinks` (rich embeds instead
of plain text — optional), `ManageRoles` (role mention on alert, Stripe role rewards — optional).

## Privileged intents

None.

## Privacy notes

- OAuth tokens and webhook secrets are encrypted at rest (AES-256-GCM) and only decrypted in-process to make a
  request.
- Webhook secrets are shown in plaintext exactly once, at creation.
- Alert connectors only read publicly available data about the watched target; no member data or message content
  is ever sent to a provider.
- Stripe events never carry card data — only price ids and the Discord user id from checkout metadata.
- Twitch chat messages are parsed in memory only, to match a command — never persisted, logged, or sent to
  Discord.

## Dashboard page

`/dashboard/[guildId]/integrations` — provider cards with connect/disconnect + setup hints (missing env vars),
alert watch management, and inbound/outbound webhook tabs with deliveries.

## Known limitations / design notes

- `apps/bot/src/host/bot-actions.ts`'s dispatcher currently invokes every `ServiceMap` method with a single
  `{ guildId, payload, requestedBy }` job object, regardless of the method's declared positional signature. This
  plugin's `IntegrationsService.sendOutbound`/`testWebhook` are written to tolerate both that call shape and the
  documented positional one (`sdk/services.ts`), but the mismatch itself is a bot-host-owned file this plugin
  cannot fix — flagged for a wiring-stage reconciliation pass.
- Twitch **stream-live alerts** and Reddit are polled with **app-level** credentials (client-credentials
  grant), not a per-connection user OAuth token — matching SPEC.md §J's "client-credentials app token" /
  "app-only OAuth" wording. `twitch` and `reddit` are still listed as OAuth providers in
  `apps/api/src/lib/integrations/providers.ts` (pre-existing, not changed here); that dashboard OAuth flow links
  the connecting staff member's own account but isn't required for alerts to work — `/integration alerts add`
  (app-token based) is what actually watches a target. The **Twitch chat bot** (above) is the exception: it
  genuinely runs on real per-connection user OAuth — the broadcaster's `channel:bot` grant plus Pavisie's own
  dedicated bot-account token — not the app-level client-credentials grant the alert watcher uses.
- GitHub's optional `repo:`/`branch:` filters are encoded as extra entries in `WebhookEndpoint.events` (there's no
  dedicated filter column on that model) rather than a real event-type allowlist plus separate filter fields.
