# integrations

Secure connector framework for optional external services (SPEC.md §J). Disabled by default. Every connector
degrades independently when its env vars are unset — the plugin itself never becomes unavailable.

## What it does

- **Alert watchers** (poll on a cron, one Discord channel + optional role per watched target):
  - **Twitch** — `stream.online` alerts. Needs no Twitch login (app credentials only; `kind: 'apikey'`). Uses EventSub
    (webhook push, near-instant) when `PUBLIC_WEBHOOK_BASE_URL` and `TWITCH_EVENTSUB_SECRET` are set, else falls back
    to polling Helix `GET /streams` every 2 minutes. Stale/foreign-callback/failed subscriptions are replaced and
    orphaned ones cleaned up by the `twitch-eventsub-cleanup` job (docs/ARCHITECTURE.md §19a-i).
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

## Twitch chat bot, channel points and currency (runtime only; managed on the creator dashboard)

Since creator-dashboard phase 4 (`docs/ARCHITECTURE.md` §19e) the Discord side of this plugin is **notifications
and alerts only**. The Twitch chat bot, channel-point rewards (OBS overlay, TTS), the channel's virtual currency,
the Discord <-> Twitch chat bridge and the link to a Discord server are all managed ONLY by the streamer, on the
creator dashboard (`pavisie.com/creator`, `apps/api/src/routes/creator-twitch*.ts`). There is no `/twitch` slash
command and no "Twitch chat" tab on `/dashboard/[guildId]/integrations` any more — that page only shows a read-only
notice naming the linked channel (if any), with a button that lets a server admin unlink their server.

What still lives in this package is the **runtime**: `twitch-chat/` (`helix.ts`, `socket.ts`, `manager.ts`,
`engine.ts`, `timers.ts`, `rewards.ts`, `tts.ts`, `broadcaster-token.ts`, the economy and bridge modules) plus the
`twitch-chat-tick` job. See `docs/ARCHITECTURE.md` §19a (chat bot), §19b (channel points) and §18b (currency).

- **Ownership**: the chat bot belongs to the streamer. `TwitchChatChannel` rows run on their own `enabled` flag,
  guild-linked or not — a server admin switching the `integrations` plugin off does NOT stop a linked channel's chat
  bot, commands, timers, currency or SOUND/CHAT/TTS rewards.
- **What still respects the server's plugin switch**: only the features that act INSIDE a Discord server — the
  Discord <-> Twitch chat bridge (both directions, including the "now bridged" announcements and webhook provisioning)
  and the DISCORD channel-point reward action. With the plugin off in the linked server they are skipped quietly and
  resume when it is back on.
- **Identity**: ONE dedicated Twitch bot account, authorized once by the operator (owner-only
  `POST /owner/twitch-bot/connect`); a streamer connects their channel from `/creator` (scope `channel:bot`, plus
  `channel:read:redemptions` if they enable channel points).
- **What is NOT stored**: chat message content or chatter identity. Messages are parsed **in memory only**, to match a
  command, and are never written to a database row, a log line, or Discord (outside the opt-in bridge, which relays
  text in memory only). Viewer reward-input text is never stored or logged either.
- **Degradation**: with `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` unset, or before the operator authorizes the bot
  account, the manager stays idle and this plugin's `health()` says why.

## Commands

`/integration connect <provider> [target] [channel] [role] [template]` — OAuth providers (Instagram, Google/Microsoft
Calendar) reply with a dashboard link (OAuth must start from a signed-in dashboard session); apikey/public providers
(Twitch, YouTube, Reddit, Steam) create the connection immediately if `target`+`channel` are given.
`/integration disconnect <connection>` · `/integration status [connection]` · `/integration list`
`/integration alerts add|remove|list` — Twitch/YouTube/Reddit/Steam watch targets (one `IntegrationConnection` row
per target).
`/integration webhook create|list|delete` — inbound endpoints; the secret is shown exactly once, at creation.
`/integration outbound create|list|delete|test` — outbound endpoints.

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
- Twitch chat messages (handled by the streamer-owned chat bot runtime above) are parsed in memory only, to match a
  command — never persisted or logged; the opt-in Discord bridge relays them in memory only.

## Dashboard page

`/dashboard/[guildId]/integrations` — provider cards with connect/disconnect + setup hints (missing env vars),
alert watch management, inbound/outbound webhook tabs with deliveries, and a read-only "Twitch chat, channel points
and currency moved to the creator dashboard" notice (with the linked channel and an Unlink button when applicable).

## Known limitations / design notes

- `apps/bot/src/host/bot-actions.ts`'s dispatcher currently invokes every `ServiceMap` method with a single
  `{ guildId, payload, requestedBy }` job object, regardless of the method's declared positional signature. This
  plugin's `IntegrationsService.sendOutbound`/`testWebhook` are written to tolerate both that call shape and the
  documented positional one (`sdk/services.ts`), but the mismatch itself is a bot-host-owned file this plugin
  cannot fix — flagged for a wiring-stage reconciliation pass.
- Twitch **stream-live alerts** and Reddit are polled with **app-level** credentials (client-credentials
  grant), not a per-connection user OAuth token — matching SPEC.md §J's "client-credentials app token" /
  "app-only OAuth" wording. `twitch` is therefore `kind: 'apikey'` (the per-server Twitch OAuth "Connect" was
  removed; the OAuth machinery in `apps/api/src/lib/integrations/providers.ts` remains only for the owner's bot
  identity and the creator dashboard). `reddit`'s per-guild OAuth link is still offered but isn't required for alerts
  — `/integration alerts add` (app-token based) is what actually watches a target. The **Twitch chat bot** (above) is the exception: it
  genuinely runs on real user OAuth — the broadcaster's `channel:bot` grant plus Pavisie's own dedicated
  bot-account token — not the app-level client-credentials grant the alert watcher uses.
- GitHub's optional `repo:`/`branch:` filters are encoded as extra entries in `WebhookEndpoint.events` (there's no
  dedicated filter column on that model) rather than a real event-type allowlist plus separate filter fields.
