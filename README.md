<p align="center">
  <img src="assets/brand/pavisie-skull.png" width="120" alt="Pavisie" />
</p>

<h1 align="center">Pavisie</h1>

<p align="center">A modular, compliance-first Discord bot platform.</p>

---

## Table of contents

1. [What Pavisie is](#what-pavisie-is)
2. [Feature overview](#feature-overview)
3. [Architecture at a glance](#architecture-at-a-glance)
4. [Prerequisites](#prerequisites)
5. [Discord Developer Portal setup](#discord-developer-portal-setup)
6. [Invite URL](#invite-url)
7. [Local setup — with Docker](#local-setup--with-docker)
8. [Local setup — without Docker](#local-setup--without-docker)
9. [First-run checklist in Discord](#first-run-checklist-in-discord)
10. [Production deployment](#production-deployment)
11. [Plugin configuration guide](#plugin-configuration-guide)
12. [Permissions matrix](#permissions-matrix)
13. [Privacy & data](#privacy--data)
14. [Website & donations](#website--donations)
15. [Development](#development)
16. [Troubleshooting](#troubleshooting)
17. [Roadmap](#roadmap)
18. [License](#license)
19. [Credits](#credits)

---

## What Pavisie is

Pavisie is a production-ready, modular "all-in-one" Discord bot platform: moderation, automod,
logging, tickets, roles and onboarding, leveling and community features, integrations, an optional
AI assistant, and a full admin dashboard, all built as independently enable/disable-able plugins per
server. The brand is deliberately **monochrome** — black, grey, and white, everywhere from the bot's
avatar (a pixel-art skull) to the dashboard to the public marketing site — because Pavisie's pitch
isn't a flashy feature list, it's trust: every action the bot takes is logged, every permission it
asks for is least-privilege and explained, and nothing about how it moderates your server is hidden
from you.

The headline feature is the **Admin Enforcer**: a policy-driven, hands-off moderation workflow where
moderators never DM or confront a suspect directly. A server admin defines plain-language policies;
the bot watches for matches (or staff flag something manually) and posts the exact chat context to a
private queue; a moderator reviews it and picks an action; the bot carries out the action and
messages the user itself. Every flag and every decision is written to a read-only, tamper-evident
ledger channel and to the database — searchable, exportable, and appealable. It's moderation that
stays professional and consistent no matter which moderator is on duty, with a paper trail nobody has
to trust blindly. That same philosophy — least-privilege permissions, no message content logged
unless a feature explicitly needs it and an admin turns it on, a virtual-only economy with no real
money involved, and a full audit trail of every config change — runs through every plugin in the
platform, not just Enforcer. Compliance isn't a checkbox here; it's the product's moat.

## Using the bot: the + prefix

Every Pavisie command works two ways: type it in chat with a `+` prefix (e.g. `+help`, `+mod ban @user spam`) or use the `/` slash-command menu. The `+` prefix is there because a busy server's slash menu is crowded with other bots — with `+`, you type faster and the command reference is always one `+help` away. Start with **`+help`** to see every command. Both forms work identically; use whichever feels natural.

## Feature overview

15 plugins, each independently enabled or disabled per Discord server. "Privileged intents" are
Discord features that must be explicitly turned on for the bot (see
[Discord Developer Portal setup](#discord-developer-portal-setup)); plugins that need one and don't
have it degrade gracefully instead of breaking — see `docs/PERMISSIONS.md` for exactly what changes.

| Plugin                 | What it does                                                                                                             | Default              | Privileged intents              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------- |
| **Admin**              | Guided server setup, core config, plugin enable/disable, permission auditing, bot health — the always-on control plane.  | Enabled (always on)  | —                               |
| **Moderation**         | Warnings, timeouts, kicks, bans, cases, and the moderator hierarchy — the core toolkit.                                  | Enabled              | —                               |
| **Automod**            | Configurable spam, mention, invite, scam-link, word/regex, caps, and raid-detection rules, dry-run by default.           | Enabled (dry-run on) | Message Content, Server Members |
| **Enforcer**           | Policy-driven, hands-off moderation with a flag queue and a read-only ledger — the headline feature.                     | Disabled             | Message Content                 |
| **Logging**            | Routes member/message/role/channel/moderation/voice events to log channels, with redaction and retention.                | Enabled              | Server Members, Message Content |
| **Tickets**            | Button-driven support tickets: categories, staff assignment, tags, HTML/JSON transcripts.                                | Disabled             | Message Content                 |
| **Roles & Onboarding** | Self-assignable role panels, welcome/goodbye, onboarding checklist, member verification.                                 | Disabled             | Server Members                  |
| **Engagement**         | Leveling/XP with anti-farming controls, leaderboards, reputation, starboard, temp voice channels.                        | Enabled              | Message Content                 |
| **Community**          | Polls, giveaways, suggestions, scheduled announcements, reminders, event RSVPs.                                          | Enabled              | —                               |
| **Game Stats**         | Steam-linked leaderboards for a shared game (Dead by Daylight first) — opt-in linking, self-service. Unavailable until a Steam Web API key is configured. | Disabled             | —                               |
| **Economy**            | Optional virtual-currency balance/daily/give/leaderboard — no real money, ever.                                          | Disabled             | —                               |
| **Utility**            | `/help`, user/server info, timestamps, embed builder, AFK, translation, weather, bot health.                             | Enabled              | —                               |
| **Music & Media**      | Playlist/queue management for a legal, user-authorized audio provider only. Unavailable until one is configured.         | Disabled             | —                               |
| **Integrations**       | Secure connector framework: Twitch, YouTube, Instagram, Reddit, Steam, Google/Microsoft Calendar, webhooks. | Disabled             | —                               |
| **AI Assistant**       | Optional `/ask`, `/summarize`, `/draft`, `/mod-assist` — per-server opt-in, cooldowns, token budgets.                    | Disabled             | —                               |

Full command list per plugin: `docs/commands.json` (generated, always current) or the website's
**Features & Commands** page.

## Architecture at a glance

```
pavisie/
├── apps/
│   ├── bot/            Discord gateway process + BullMQ workers
│   ├── api/             Fastify REST API, Discord OAuth, webhook receivers, OpenAPI
│   ├── dashboard/       Next.js app; legacy app.pavisie.com redirector today, owner-only ops console next
│   └── web/             Next.js public marketing site + donations + the per-guild config dashboard (pavisie.com, incl. /dashboard/**)
├── packages/
│   ├── types/           Shared TypeScript types (no runtime deps)
│   ├── core/             env config, logger, errors, encryption, permissions, rate limiting, i18n
│   ├── database/         Prisma schema, client, migrations, seed
│   ├── plugins/          Plugin SDK + every feature plugin
│   └── ui/               Dashboard component library
├── infra/
│   ├── docker/           Dockerfile.bot, Dockerfile.api, Dockerfile.dashboard, Dockerfile.web
│   └── DEPLOYMENT.md
├── assets/brand/         Logo source (pavisie-skull.png / .jpg)
├── docs/                 SPEC, ARCHITECTURE, PERMISSIONS, TROUBLESHOOTING, and more
├── .github/workflows/ci.yml
├── docker-compose.yml
└── .env.example
```

**Data flow, in short**: the bot maintains one connection to Discord's gateway and talks directly to
Postgres (via Prisma) and Redis for guild config, moderation cases, rate limits, cooldowns, and
queues; it also hosts BullMQ workers for every plugin's background jobs plus a shared `bot-actions`
queue the dashboard uses to ask the bot to do Discord-side things it can't do over plain HTTP — post a
role panel, send a test welcome message, carry out an Enforcer decision. The API is the only thing
the dashboard and the public website ever talk to over HTTP; it shares the same Postgres/Redis as the
bot (not the gateway connection), so a change made through the dashboard — enabling a plugin, editing
a policy — is picked up by the bot after a short cache invalidation, typically well under a second.

See `docs/ARCHITECTURE.md` for the full binding design and `docs/SPEC.md` for product requirements.

## Prerequisites

- **Node.js 22+** (`.nvmrc` pins 22; the dev machine this was built on runs 24)
- **pnpm 9.15.x** — `corepack enable` will pick up the version pinned in `package.json`
  automatically, or install directly: `npm install -g pnpm@9.15.9`
- **Docker Desktop** (recommended path) — or standalone **PostgreSQL 16** and **Redis 7** if you'd
  rather run those natively
- **A Discord account** with permission to create applications (any account can)
- **Git**

## Discord Developer Portal setup

1. Go to <https://discord.com/developers/applications> and click **New Application**.
2. Name it (e.g. "Pavisie") and click **Create**.
3. On the **General Information** page, click the app icon and upload
   `assets/brand/pavisie-skull.png` as the application icon. Click **Save Changes**.
4. Click **Bot** in the left sidebar. Upload the same `assets/brand/pavisie-skull.png` as the bot's
   avatar.
5. Still on the **Bot** page, click **Reset Token** → confirm → **Copy**. This is your
   `DISCORD_TOKEN` — treat it like a password; it's shown only once per reset.
6. Scroll to **Privileged Gateway Intents** and turn on what you need:
   - **Server Members Intent** — **ON**. Needed for joins/leaves, welcome messages, raid detection,
     role persistence (`ENABLE_GUILD_MEMBERS_INTENT=true`, the default).
   - **Message Content Intent** — **only if** you need content-dependent features (Automod's
     word/regex/scam-link rules, Enforcer's automatic flagging, full-text ticket transcripts, the
     starboard's message preview). Everything that needs it degrades gracefully without it (see
     `docs/PERMISSIONS.md`) rather than breaking. **Once your bot is in 100+ servers, Discord
     requires you to apply for approval** to keep this intent enabled — see Discord's own
     [Privileged Intent FAQ](https://support-dev.discord.com/hc/en-us/articles/4404772028055) for
     the eligibility/verification process. Below that threshold it works immediately when you flip
     the toggle.
   - **Presence Intent** — leave off; nothing in Pavisie uses it by default.
7. Click **OAuth2** in the sidebar → **General**. Under **Redirects**, click **Add Redirect** and
   add **both** of these (one for local development, one for production):
   ```
   http://localhost:3001/auth/discord/callback
   https://api.pavisie.com/auth/discord/callback
   ```
   Click **Save Changes**.
8. On the same page, copy the **Client ID** (also shown on General Information as **Application
   ID**) → this is `DISCORD_CLIENT_ID`. Copy the **Client Secret** → this is
   `DISCORD_CLIENT_SECRET`.

You now have three values: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`.

## Invite URL

Scopes: **`bot`** and **`applications.commands`** (both required — without `applications.commands`
your slash commands never appear, even once registered). Permission integer is the least-privilege
set in `docs/invite.json` / `packages/core/src/permissions/discord.ts` — **never Administrator**.

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=1504210971862
```

Replace `YOUR_CLIENT_ID` with your `DISCORD_CLIENT_ID`. The exact permission list and why each one
is requested is in `docs/PERMISSIONS.md` → "Invite permissions".

## Local setup — with Docker

```bash
git clone <this repo>
cd pavisie
cp .env.example .env
```

Open `.env` and fill in these **6 required values** (everything else has a working local default):

```
DISCORD_TOKEN=            # from Discord Developer Portal setup step 5
DISCORD_CLIENT_ID=        # step 8
DISCORD_CLIENT_SECRET=    # step 8
DISCORD_OAUTH_REDIRECT_URI=http://localhost:3001/auth/discord/callback   # already correct, just confirm it matches step 7
ENCRYPTION_KEY=           # generate: openssl rand -base64 32
SESSION_SECRET=           # generate: openssl rand -base64 32
```

Then:

```bash
docker compose up -d          # postgres, redis, migrate (runs once), bot, api, dashboard, web
pnpm install                  # only needed once, so you can run pnpm scripts on your host below
pnpm --filter @pavisie/bot register --guild YOUR_TEST_SERVER_ID   # instant command registration
```

The `migrate` service in `docker-compose.yml` runs `pnpm db:migrate` automatically before `bot`,
`api`, and `dashboard` start — you don't need to run it by hand. The per-guild config dashboard
lives inside the website now (not its own app) — open it at <http://localhost:3003/dashboard>. The
API's Swagger docs are at <http://localhost:3001/docs>, and the public website itself is at
<http://localhost:3003>. (`apps/dashboard` still runs at <http://localhost:3000> — today it's just
a legacy-link redirector plus a placeholder for Brandon's upcoming owner-only ops console, see
`docs/ARCHITECTURE.md` §11a.)

## Local setup — without Docker

Requires a running **PostgreSQL 16** and **Redis 7** you point `.env`'s `DATABASE_URL`/`REDIS_URL`
at (e.g. installed natively, or `docker compose up -d postgres redis` if you want Docker for just
the data layer).

```bash
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm commands:register
pnpm dev
```

`pnpm dev` runs `bot`, `api`, `dashboard`, and `web` together (the config dashboard is part of
`web` now — see above — so this is also how you get it locally; `apps/dashboard`'s own dev server
has nothing you need for guild config, just the legacy-link redirect and, soon, the ops console).

## First-run checklist in Discord

Once the bot is running and invited to a test server, run these in order:

1. **`/setup wizard`** — guided first-time configuration (staff roles, mod-log channel, timezone).
2. **`/permissions audit`** — confirms the bot actually has every permission it was invited with;
   flags anything missing and what it affects.
3. **`/plugin list`** — shows every plugin's enabled/disabled state and availability (a plugin can
   be "enabled" but still `unavailable` if a required env var or intent is missing).
4. **`/enforcer setup`** — only if you want the headline Enforcer feature; walks through creating
   the ledger channel, the flag-queue channel, and the mute role. Requires the `moderation` plugin
   enabled first.

## Production deployment

Production is meant to run in the cloud, not on a home machine — this repo does not assume anyone
is running a bot on their own laptop long-term. **Recommended: Railway** (always-on services,
managed Postgres/Redis, deploy straight from GitHub). Render (via `render.yaml`) and a plain VPS
(via the same `docker-compose.yml`) are both documented alternatives.

**Full step-by-step operations guide: `infra/DEPLOYMENT.md`** (migrations, backups, log shipping,
updating, rollback, rough cost guidance) — this README only summarizes the shape of it so it isn't
duplicated in two places.

Canonical production layout on `pavisie.com`:

| Surface                        | URL                                                   | Key env var(s)                                                   |
| ------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------- |
| Website + config dashboard     | `https://pavisie.com` (+ `www` redirects to apex), dashboard at `/dashboard/**` | `WEB_URL`                                    |
| Legacy dashboard redirect / ops console | `https://app.pavisie.com`                | `DASHBOARD_URL` (same value as `WEB_URL` now)                    |
| API                            | `https://api.pavisie.com`                         | `API_BASE_URL`, `NEXT_PUBLIC_API_URL`, `PUBLIC_WEBHOOK_BASE_URL` |
| Cookies                        | shared apex domain                                    | `COOKIE_DOMAIN=.pavisie.com`, `SESSION_COOKIE_SAMESITE=lax`  |
| Discord OAuth redirect         | `https://api.pavisie.com/auth/discord/callback`   | `DISCORD_OAUTH_REDIRECT_URI`                                     |
| Twitch/GitHub/generic webhooks | `https://api.pavisie.com/webhooks/...`            | —                                                                |

`.env.production.example` is pre-filled with every one of these values for `pavisie.com` —
copy it and fill in only the blank secrets (`DATABASE_URL`, `REDIS_URL`, `DISCORD_TOKEN`,
`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `ENCRYPTION_KEY`, `SESSION_SECRET`, and whichever
optional integrations you're turning on).

**DNS**: at your registrar, create `CNAME app`, `CNAME api`, `CNAME www` pointed at your host's
per-service targets, and an apex `pavisie.com` record via ALIAS/ANAME (or your host's specific
apex-domain instructions). TLS is provisioned automatically by the host once DNS resolves.

Not a developer, or want the exact Railway click-path with no jargon? See
**`docs/QUICKSTART-NON-TECHNICAL.md`**.

## Plugin configuration guide

Every plugin has its own per-guild config, editable from `/config set` in Discord or the dashboard's
**Plugins** page (the config form is generated automatically from each plugin's schema, so it's
never out of sync with what the bot actually reads). Full guide, one section per plugin, with every
config key explained: **`docs/PLUGINS.md`**.

## Permissions matrix

Every Discord permission each plugin can use, why it's needed, whether it's optional, and what
happens if it's missing — plus which plugins need which privileged intent and what degrades without
it. Generated directly from the plugin registry (`pnpm docs:permissions`), so it can never drift
from what the code actually declares. Full matrix: **`docs/PERMISSIONS.md`**.

## Privacy & data

Defaults, out of the box, before any admin changes a setting:

- **No message content is logged.** Edit/delete logs, automod events, and Enforcer flags record
  metadata only (author, channel, time) unless the relevant Message Content intent is enabled **and**
  the specific admin-facing toggle for that plugin is turned on.
- **Data retention is configurable per server**, with sensible defaults (e.g. 90 days for logs and
  ticket transcripts) enforced by an automatic retention job.
- **Export and delete** are self-serve from the dashboard's **Privacy** page — an admin can export
  everything Pavisie holds for their server as JSON, or request full deletion (guild data cascades
  from a single `Guild` row deletion).
- **OAuth tokens and webhook secrets are encrypted at rest** (AES-256-GCM) and only decrypted
  in-process to make the one API call that needs them.

Template privacy policy (for the operator to review, adapt, and publish — not a substitute for legal
advice): **`docs/PRIVACY_POLICY_TEMPLATE.md`**.

## Website & donations

`apps/web` (`@pavisie/web`) is the public marketing site at `pavisie.com` — separate from the
admin dashboard, monochrome "smoky UI" theme, and its command documentation is generated from the
real plugin registry so it can never hand-drift from what the bot registers (see
[Development](#development)).

Donations are handled entirely by **Ko-fi** (a third-party donation platform) — Pavisie no longer processes
payments at all. The Donate page links to the operator's Ko-fi page when configured, or shows a "not set up"
notice when missing. See `docs/ARCHITECTURE.md` §18 for the full contract and `docs/SECURITY.md` for the
incident history (Stripe account ban on 2026-08-26 → moved to Ko-fi). Required env: `KOFI_URL` (full Ko-fi
page URL, e.g. `https://ko-fi.com/yourname`). Optional (previously required for donations, now only for the
`roles` plugin's optional CAPTCHA verification mode): `CAPTCHA_PROVIDER` with its keys.

Donations stay **disabled** — the Donate page shows a "not configured" notice — when `KOFI_URL` is unset.

The **Support** page (`/support`) is the primary support destination: joining the community Discord
server is the main call to action, with pointers to the dashboard (configuration) and `/features`
(command reference). Also linked from the primary nav and the footer. Optional env:
`NEXT_PUBLIC_SUPPORT_SERVER_URL` — the page (and every other surface that links the server) shows
nothing/a plain notice instead of a broken link when it's unset.

## Development

Root scripts (`package.json`), run from the repo root:

| Script                         | What it does                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                     | Runs `bot`, `api`, `dashboard`, `web` together in watch mode (the config dashboard is part of `web`'s dev server — see above)                                          |
| `pnpm lint`                    | Lints every package/app                                                                                                                                                 |
| `pnpm typecheck`               | Type-checks every package/app (`tsc --noEmit`)                                                                                                                          |
| `pnpm test`                    | Runs every package/app's Vitest suite                                                                                                                                   |
| `pnpm test:e2e`                | Runs the website's Playwright specs — marketing smoke tests plus the dashboard's OAuth login/config flows, now that both live in `apps/web` (they self-skip without a running `E2E_TEST_MODE=true` API — see `apps/web/README.md`) |
| `pnpm build`                   | Builds everything with a real build step (mainly `dashboard` and `web`)                                                                                                 |
| `pnpm db:generate`             | Regenerates the Prisma client                                                                                                                                           |
| `pnpm db:migrate`              | Applies committed migrations (`prisma migrate deploy`) — safe for production                                                                                            |
| `pnpm db:migrate:dev`          | Generates + applies a new migration from schema changes — dev only, never against prod                                                                                  |
| `pnpm db:seed`                 | Seeds a clearly-labelled demo guild (`Pavisie Demo (seed)`) — never fake real-looking data                                                                             |
| `pnpm commands:register`       | Registers slash/context-menu commands with Discord (`DEV_GUILD_ID` if set, else global)                                                                                 |
| `pnpm commands:export`         | Regenerates `docs/commands.json`, `docs/invite.json`, and the website's copies from the live plugin registry                                                            |
| `pnpm docs:permissions`        | Regenerates `docs/PERMISSIONS.md` from the live plugin registry                                                                                                         |
| `pnpm check:i18n`              | Verifies every plugin registers `locales/en.json` and every `t('key')`/`c.t('key')` call site resolves to a real translation (not just a fallback to the raw key)       |
| `pnpm brand:sync`              | Copies the brand logo from `assets/brand/` into each app's `public/` (no-op if the source file is missing)                                                              |
| `pnpm format` / `format:check` | Prettier write / check                                                                                                                                                  |

**Tests**: Vitest per package, focused on logic that doesn't need a live Discord gateway
(permission checks, automod rule evaluators, moderation hierarchy, encryption, signature
verification) plus Playwright for the dashboard's OAuth login and config flows. See
`docs/ARCHITECTURE.md` §13 for the full testing conventions.

**CI** (`.github/workflows/ci.yml`): install → generate Prisma client → validate schema → lint →
typecheck → test → **export commands and fail if `docs/commands.json`/`docs/invite.json` are
stale** → **export the permissions matrix and fail if `docs/PERMISSIONS.md` is stale** → run
migrations against a real service database → build. Both freshness checks exist so the generated
docs can never silently drift from the code that produced them — if you add or change a command or
a plugin's permissions and forget to run the export, CI catches it, not a user reading stale docs.

## Troubleshooting

**First-line support is the community Discord server** — linked on the website's `/support` page,
its footer, and in the dashboard sidebar and error states (`NEXT_PUBLIC_SUPPORT_SERVER_URL`; hidden
everywhere it isn't configured). For self-serve fixes — bot won't start, commands not showing,
"Missing Permissions", dashboard login loops, webhook delivery, Prisma/Redis errors, Windows notes,
Railway specifics: **`docs/TROUBLESHOOTING.md`**.

## Roadmap

MVP → v1 → future modules, in order: **`docs/ROADMAP.md`**.

## License

Pavisie is open source under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE).
In short: you are free to use, study, modify, and self-host it, but if you run a modified version as a
network service you must make your modified source available to its users under the same license.

## Credits

Built by Brandon Simonds and contributors. Bot avatar and brand mark: `assets/brand/`. See
`docs/ARCHITECTURE.md` and `docs/SPEC.md` for the full design and requirements this platform was
built against.
