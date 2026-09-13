# Roadmap

Honest status, not aspirational marketing copy. "MVP" below is what's actually built and working
today; it explicitly calls out the handful of places that are scaffolding-only or need a manual step,
because pretending otherwise would violate the no-fake-data rule this whole project runs on. "v1" is
hardening work with no new user-facing surface area. "Future modules" are real feature ideas that
haven't been started.

## MVP — what exists now

Everything in `docs/ARCHITECTURE.md` §7.1's plugin table is implemented and tested: 15 plugins
covering moderation, automod, the Enforcer dispute/ledger workflow, logging, tickets, roles/
onboarding/verification, engagement (leveling/reputation/starboard/temp-voice), community (polls/
giveaways/suggestions/announcements/reminders/events), Steam-linked game-stats leaderboards, a
virtual-currency economy, utility commands, integrations (OAuth connections + inbound/outbound
webhooks + alert connectors + a Twitch chat bot with custom commands/timers), and an optional AI
assistant. The dashboard covers every plugin with a settings page, the marketplace enable/disable
grid, a JSON-schema-driven config drawer, audit log viewer, and privacy controls (export/delete/
retention). The public website covers the full command reference (generated from the plugin
manifests, not hand-maintained — see ARCHITECTURE §17), donations via Ko-fi link-out, and
privacy/terms pages. CI runs lint, typecheck, 931+ tests, and both app builds on every push; the repo
stays green and runnable with `npm run dev` (well, `pnpm dev`) at every commit.

Deployment is documented cloud-first for Railway (recommended), Render (Blueprint alternative), and
any VPS via `docker-compose.yml` behind Caddy — see `infra/DEPLOYMENT.md`.

**What's scaffolding-only or needs a manual step today — said plainly, not hidden:**

- **Media/music playback is queue management only, not audio.** The `media` plugin manages an
  abstract, Redis-backed queue of track references and is unavailable by default
  (`MEDIA_PROVIDER=none`). `@discordjs/voice` is intentionally not wired up — no shipped provider
  actually joins a voice channel or plays audio. The `MediaProvider.createStream()` hook exists so a
  future compliant voice adapter can be added without touching command code, but none is implemented
  yet (see `packages/plugins/src/media/README.md` for why — no scraping/ripping of streaming
  platforms, only a licensed-provider adapter model).
- **E2E tests need a running API, not just the dashboard.** `apps/dashboard`'s Playwright suite
  (`e2e/`) exercises the real dashboard against a real API in `E2E_TEST_MODE=true` (which enables a
  synthetic test-login route that refuses to exist when `NODE_ENV=production`). CI's `e2e` job starts
  the API, waits for `/health`, then runs the dashboard against it — this isn't a limitation of the
  tests so much as a note for anyone trying to run `pnpm test:e2e` locally: it will hang or fail
  against a dashboard alone with no API behind it.
- **Engagement XP adjustments don't re-sync level-role rewards instantly.** `/level xp give|remove|
set` (and the equivalent dashboard action) changes a member's stored XP/level immediately, but
  level-role rewards are only granted/revoked when a member naturally levels up through
  `level.up` events **or** when a staff member explicitly runs `/level rewards sync` (or the
  dashboard's equivalent), which recomputes every ranked member's role rewards in one pass. Manually
  setting someone to level 20 doesn't hand them the level-20 role until that sync runs. This is a
  deliberate scope boundary (avoiding an automatic bulk role-mutation on every admin edit) rather than
  an oversight, but it's easy to expect otherwise, so it's called out here.
- **Analytics dashboard has no collection job yet.** `/dashboard/[guildId]/analytics` reads
  `GuildAnalyticsDaily` and renders charts when `GuildConfig.dataCollectionEnabled` is on, but the
  scheduled job that actually populates `GuildAnalyticsDaily` day-by-day is v1 work (see below) — the
  page and its API route exist and work correctly against whatever rows are there, honestly showing
  an empty state until a real collection job exists, not fake data.
- **Privacy policy/terms pages are explicitly templates.** `apps/web`'s `/privacy` and `/terms`
  render a visible "this is a template" banner on purpose — see
  `docs/PRIVACY_POLICY_TEMPLATE.md`'s intro. This is intentional, not a gap to close by MVP; it needs an
  operator's actual review before it stops being a template, which is outside engineering scope.
- **Twitch chat bot is live.** The `integrations` plugin joins a streamer's Twitch chat (EventSub
  WebSocket + Helix send, custom `!commands`/timers, built-in `!commands`/`!uptime`/`!title`) once a
  streamer links their channel from the dashboard. The one-time authorization of the platform's dedicated
  Twitch bot account is done on the hosted deployment; self-hosters do it once via
  `POST /owner/twitch-bot/connect`. Until that step, the feature honestly reports itself as not configured
  rather than failing silently. No Twitch-side moderation actions (ban/timeout/delete) ship in v1 —
  custom commands and timers only.
- **Twitch channel-point rewards are live.** Viewers redeeming a custom Twitch channel-point reward triggers
  one of four actions: play a sound on the streamer's OBS overlay, speak text via TTS (using the guild's own
  OpenAI key, or unavailable if not configured), post to Twitch chat, or post to a Discord channel. Configured
  per-channel from `/twitch reward add|remove|list` or the dashboard's "Rewards" tab. Existing linked channels
  **must re-link to grant `channel:read:redemptions` scope** before the broadcaster's rewards can start working —
  the reconcile loop reports this plainly rather than silently failing. TTS synthesis is server-side (OBS's
  embedded browser has no voices), and sound URLs are validated by the existing SSRF guard at write time. Viewer
  reward-input text is never persisted or logged. The overlay is an HTML page served at a capability-token URL
  (treat the URL like a password) and can be regenerated without re-linking.
- **Game-stats leaderboards need a Steam Web API key.** The `gamestats` plugin (`/dbd link|unlink|
  stats|leaderboard|refresh`) lets members opt in with their own Steam account and compares curated
  stats on a per-guild leaderboard — Dead by Daylight is the first (and, for now, only) supported
  game. It is **Steam-only, on purpose**: there is no public stats API for console platforms, so this
  never pretends to support them, and a member's Steam profile/game details must be Public for stats
  to be fetchable. The plugin declares `STEAM_API_KEY` as required and reports itself `unavailable`
  (every `/dbd` command replies accordingly, the 30-minute refresh job no-ops) until the operator sets
  that key — a free key from `steamcommunity.com/dev/apikey`, same manual-step shape as the Twitch bot
  identity above.

## v1 — hardening

No new plugins or pages; making what exists more production-grade under real load and wider usage:

- **E2E tests running as a first-class CI job with real services**, not `continue-on-error: true`.
  Today's `e2e` job (`.github/workflows/ci.yml`) is allowed to fail without blocking merges — v1
  makes it a required check once it's proven stable enough not to be flaky noise.
- **Sharding guidance becomes a real runbook**, not just a note. `infra/DEPLOYMENT.md` §12 documents
  the trigger point (~2,500 guilds) and points at `discord.js`'s `ShardingManager`; v1 turns that into
  a tested, documented procedure with the specific code changes needed in `apps/bot/src/client.ts`
  and `src/host/*`, not just "introduce it when you need it."
- **i18n locales beyond `en`.** The i18n plumbing (`packages/core/src/i18n`, per-plugin
  `locales/en.json` merged under a namespace) already supports additional locales structurally — v1
  is actually writing and shipping a second (and third) locale, plus a process for keeping plugin
  locale files in sync as commands change.
- **Native Discord AutoMod sync.** Pavisie's own `automod` plugin is independent of Discord's
  built-in AutoMod feature today. v1 explores syncing or coordinating with Discord's native AutoMod
  rules (visibility into what it's already blocking, avoiding duplicate/conflicting rules) rather than
  operating as two unrelated systems.
- **Analytics collection jobs** — the scheduled BullMQ job(s) that populate `GuildAnalyticsDaily` from
  raw event data, making the already-built analytics dashboard show real trends instead of an empty
  state for guilds that turn data collection on.
- **Mobile polish** for the dashboard — it's responsive today (Tailwind, tested breakpoints) but
  hasn't had a dedicated mobile-first pass on the denser pages (Enforcer ledger, moderation case
  table, automod rule builder).
- **Accessibility audit** — `@pavisie/ui` components are built accessible-by-default (keyboard
  navigation, Radix primitives, semantic markup), but there's been no end-to-end audit (screen reader
  pass, color contrast check across both themes, focus-order review) of the assembled dashboard and
  website pages as a whole.

## Future modules

Not started; real ideas for after v1, not commitments with a date attached:

- **A compliant media provider adapter** — an actual `MediaProvider` implementation (against a
  licensed streaming API, not scraping) that fills in `createStream()` so `/music play` produces real
  audio in a voice channel, once a specific compliant provider is chosen and its licensing terms
  reviewed.
- **More integrations** — additional providers beyond the current Twitch/YouTube/Instagram/
  Reddit/Steam/Google/Microsoft set, as real demand shows up for specific ones.
- **Per-guild custom commands** — letting server admins define their own simple slash or text
  commands (canned responses, small automations) without needing a new plugin shipped for every
  request.
- **Localization** beyond the v1 "a second/third locale" hardening item — full community-contributed
  translation coverage across every plugin's locale files, plus a translation-contribution workflow.
- **Premium / self-host packaging** — a clearer separation (if ever needed) between what's free to
  self-host versus a hosted/managed offering, and the packaging work (licensing, versioning, update
  channel) that would require. No decision has been made that this is even wanted; it's listed here
  because it's been discussed, not because it's planned.
