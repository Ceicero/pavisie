# Deployment guide

Pavisie runs in the cloud, not on a home machine or a laptop. This guide is cloud-first: **Railway**
is the recommended path with an exact click-path below, **Render** is a documented Blueprint
alternative, and **any VPS** with the existing `docker-compose.yml` is the fallback for anyone who
wants full control. Pick one — don't mix them.

If you are not a programmer, follow the Railway section top to bottom; every step says exactly what
to click and what to paste. Nothing here requires writing code.

## 1. What you're deploying

Four deployables, all built from this one GitHub repo, plus two managed data stores:

| Deployable  | What it is                                              | Dockerfile                          | Public?                                          |
| ----------- | ------------------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| `bot`       | Discord gateway process + background job workers        | `infra/docker/Dockerfile.bot`       | No (outbound only; has a private `/health` port) |
| `api`       | REST API, Discord OAuth, webhook receivers              | `infra/docker/Dockerfile.api`       | Yes — `api.pavisie.com`                      |
| `dashboard` | Legacy-link redirector today; owner-only ops console next (Next.js) | `infra/docker/Dockerfile.dashboard` | Yes — `app.pavisie.com`                      |
| `web`       | Public marketing website + the per-guild config dashboard (`/dashboard/**`) | `infra/docker/Dockerfile.web`       | Yes — `pavisie.com`                          |
| Postgres 16 | System of record — everything durable                   | — (managed plugin/add-on)           | No                                               |
| Redis 7     | Sessions, cache, job queues (BullMQ) — not durable data | — (managed plugin/add-on)           | No                                               |

All four deployables build from the **same repo** with **Root Directory `/`** and a different
Dockerfile path each — there is nothing to fork or split out.

**Topology note (post dashboard→web merge):** the per-guild config dashboard that used to be its
own app now lives inside `web` at `pavisie.com/dashboard/**` — there is no separate admin UI
domain anymore. The `dashboard` service still exists and still deploys as a real, working Next.js
app (theme, `@pavisie/ui`, and session wiring all still work) — today its only job is redirecting
old `app.pavisie.com/dashboard/...` links (bookmarks, the Top.gg listing, a live Reddit post) to
the new `pavisie.com/dashboard/...` URLs, 308, so nothing 404s. Brandon is building an
owner-only ops console (cross-server support tickets, fleet metrics, error monitoring, bot health)
to live on this same service next, most likely on a separate `dev.pavisie.com` domain — see
`apps/dashboard/next.config.ts`'s `redirects()` doc comment for why the redirect is scoped to just
`/` and `/dashboard/*` rather than a blanket catch-all.

## 2. RECOMMENDED — Railway

Railway keeps `bot` always-on (required — Discord bots cannot sleep), gives you managed Postgres and
Redis with one click, and deploys automatically on every push to `main`.

### 2.1 Create the project and the four services

1. Go to [railway.app](https://railway.app) and sign in (GitHub sign-in is simplest since your code
   is already there).
2. Click **New Project** → **Deploy from GitHub repo** → pick the `pavisie` repo. Authorize Railway
   to access it if asked.
3. Railway creates one service from the repo. Rename it to `bot` (click the service → **Settings** →
   **Service Name**).
4. In that service's **Settings → Build**, set:
   - **Root Directory**: `/`
   - **Builder**: Dockerfile
   - **Dockerfile Path**: `infra/docker/Dockerfile.bot`
5. Repeat **+ New → GitHub Repo** three more times, picking the same `pavisie` repo each time, to
   create three more services in the same project:
   - `api` — Dockerfile Path `infra/docker/Dockerfile.api`, Root Directory `/`
   - `dashboard` — Dockerfile Path `infra/docker/Dockerfile.dashboard`, Root Directory `/`
   - `web` — Dockerfile Path `infra/docker/Dockerfile.web`, Root Directory `/`

   You should now have 4 services in one Railway project, all pointed at the same repo, each
   building a different Dockerfile.

### 2.2 Add managed Postgres and Redis

1. In the project canvas, click **+ New → Database → Add PostgreSQL**. Railway provisions it and
   names the service `Postgres`.
2. Click **+ New → Database → Add Redis**. Railway names it `Redis`.
3. You don't need to touch either service further — Railway exposes their connection strings as
   variables the other services can reference (next step).

### 2.3 Set variables

Open each service's **Variables** tab and add the variables below. Railway's variable editor
supports **reference syntax** (`${{ServiceName.VAR}}`) — use it instead of copy-pasting connection
strings so a database credential rotation propagates automatically.

**Shared by `bot` and `api`** (add to both):

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
NODE_ENV=production
LOG_LEVEL=info
DISCORD_TOKEN=<from Discord Developer Portal>
DISCORD_CLIENT_ID=<from Discord Developer Portal>
ENCRYPTION_KEY=<openssl rand -base64 32>
```

**`api` only** (in addition to the shared block above):

```
DISCORD_CLIENT_SECRET=<from Discord Developer Portal>
DISCORD_OAUTH_REDIRECT_URI=https://api.pavisie.com/auth/discord/callback
SESSION_SECRET=<openssl rand -base64 32>
API_PORT=3001
API_BASE_URL=https://api.pavisie.com
DASHBOARD_URL=https://pavisie.com
WEB_URL=https://pavisie.com
COOKIE_DOMAIN=.pavisie.com
TRUST_PROXY=1
PUBLIC_WEBHOOK_BASE_URL=https://api.pavisie.com
KOFI_URL=<optional — full Ko-fi page URL, e.g. https://ko-fi.com/yourname>
CAPTCHA_PROVIDER=turnstile
TURNSTILE_SITE_KEY=<from your Cloudflare Turnstile widget>
TURNSTILE_SECRET=<from your Cloudflare Turnstile widget>
```

> **TRUST_PROXY must be `1`.** Requests get rate-limited by IP; if this is wrong, the IP detection fails.
> `TRUST_PROXY` must be the exact hop count (`1` on Railway/Render, never a bare `true`). See the
> `TRUST_PROXY` note in `.env.production.example`. Donations are now handled by Ko-fi and don't require
> CAPTCHA setup — see §2.3 below.

`TRUST_PROXY=true` is no longer valid the way it was before — it now needs an integer hop count. `1` is correct
for Railway and Render, since both put exactly one reverse proxy in front of `api`. A bare `true` trusts the
**leftmost** entry in `X-Forwarded-For`, which the client fully controls, so an attacker can put any IP they
want at the front of that header and get a fresh rate-limit allowance on every request; `false` (or omitting
it) instead collapses every visitor onto the platform's own proxy IP, so everyone shares one rate-limit bucket.

**`dashboard` only** (still a real Next.js app — see §1's topology note. `NEXT_PUBLIC_*` vars are
build-time, so set these as Railway variables _and_ trigger a redeploy after any change, since a
variable-only save doesn't rebuild the image):

```
NEXT_PUBLIC_API_URL=https://api.pavisie.com
WEB_URL=https://pavisie.com
```

`WEB_URL` here is server-side (read at request time by this service's own `next.config.ts`
`redirects()`, not inlined at build) — it's the redirect target for the legacy `/` and
`/dashboard/*` paths (see §1). `NEXT_PUBLIC_API_URL` keeps this service's restored session/theme/UI
wiring real and working, ready for the ops console routes Brandon is building next.

**`web` only** (these are build-time — Next.js inlines `NEXT_PUBLIC_*` at build, so set them as
Railway variables _and_ trigger a redeploy after any change, since a variable-only save doesn't
rebuild the image):

```
NEXT_PUBLIC_API_URL=https://api.pavisie.com
NEXT_PUBLIC_DISCORD_CLIENT_ID=<same as DISCORD_CLIENT_ID>
NEXT_PUBLIC_INVITE_PERMISSIONS=<invite permission integer — see docs/invite.json>
NEXT_PUBLIC_SUPPORT_SERVER_URL=<optional — shown in the dashboard sidebar/error states (now part of this service) and the site's footer/support page>
```

**`bot` only**:

```
BOT_HEALTH_PORT=3002
BOT_OWNER_IDS=<your Discord user id, comma-separated if more than one>
ENABLE_GUILD_MEMBERS_INTENT=true
ENABLE_MESSAGE_CONTENT_INTENT=false
```

Add any optional integration keys (Twitch, YouTube, Reddit, AI providers, etc. — full table in
§6 below) to `api` (and `bot` where noted) only as you turn those features on. Everything not set
simply stays disabled — nothing breaks.

Don't generate a fresh `openssl rand -base64 32` for every field — generate `ENCRYPTION_KEY` and
`SESSION_SECRET` separately, each its own random value.

### 2.4 Public domains and custom domains

1. In `api`, `dashboard`, and `web`'s **Settings → Networking**, click **Generate Domain** to get a
   temporary `*.up.railway.app` URL for each — use these to sanity-check a deploy before DNS is
   wired up.
2. Still in **Settings → Networking**, click **+ Custom Domain** and enter:
   - `api` → `api.pavisie.com`
   - `dashboard` → `app.pavisie.com`
   - `web` → `pavisie.com` (and add `www.pavisie.com` as a second custom domain on the same
     service, redirecting to the apex — or point `www` at the apex via your registrar and let `web`
     handle both)
3. Railway shows you a DNS record to create for each (usually a `CNAME` pointing at something like
   `xyz.up.railway.app`, or for the apex an `A`/`ALIAS` record — Railway's UI tells you exactly which
   for your domain).
4. At your **domain registrar** (wherever `pavisie.com` is registered), open DNS management and
   add the records Railway showed you:
   - `CNAME app → <value Railway gave you>`
   - `CNAME api → <value Railway gave you>`
   - `CNAME www → <value Railway gave you>` (or a redirect rule, per registrar)
   - Apex `pavisie.com` → an `ALIAS`/`ANAME` record if your registrar supports it, pointing at
     the value Railway gave you for `web`; if your registrar only supports plain `A` records for the
     apex, follow Railway's apex-domain instructions for that case.
5. Wait for DNS to propagate (usually minutes, sometimes up to a few hours) — Railway shows a green
   check next to each custom domain once it verifies and issues TLS automatically. You do not manage
   TLS certificates yourself.
6. Go back into Discord Developer Portal → your application → **OAuth2** → add
   `https://api.pavisie.com/auth/discord/callback` as a redirect URL (must match
   `DISCORD_OAUTH_REDIRECT_URI` byte-for-byte).

### 2.5 Run migrations

Prisma migrations must run against the database **before** `bot` or `api` serve traffic on a schema
they don't recognize yet.

**Preferred — pre-deploy command** (Railway runs this before each new deploy goes live): open `api`'s
**Settings → Deploy**, and under **Pre-Deploy Command** enter:

```
pnpm db:migrate
```

This makes every deploy migrate-then-boot automatically, including the very first one.

**One-off alternative** (first deploy, or to run it manually): install the
[Railway CLI](https://docs.railway.app/guides/cli), then from the repo root:

```
railway login
railway link          # pick this project
railway run --service api pnpm db:migrate
```

### 2.6 Register slash commands and set the bot avatar

Both are one-off CLI commands, run once (and again only when commands change):

```
railway run --service bot pnpm commands:register
railway run --service bot pnpm --filter @pavisie/bot set-avatar
```

`commands:register` registers slash commands globally (can take up to an hour to show up
everywhere the first time — set `DEV_GUILD_ID` temporarily on `bot` and re-run for instant
registration to one test server while you're verifying). `set-avatar` uploads
`assets/brand/pavisie-skull.png` as the bot's Discord avatar — you only need to run it once (Discord
rate-limits avatar changes).

### 2.6a Setting up a hub/community server from a plan

If you're also running Pavisie's own community hub server (support, announcements, the
server-owner lounge), it's configured declaratively rather than by hand: `scripts/hub-setup.mjs`
reconciles a real Discord server's roles, channels, permissions, and pinned messages against a
plan JSON, idempotently (safe to re-run) and read-only by default (`--dry-run`; pass `--apply` to
actually write). Run it from a machine with the repo checked out and `DISCORD_TOKEN` set — see
`infra/hub/README.md` for the plan schema and full usage.

### 2.7 Health checks

- `api`: `GET https://api.pavisie.com/health` → `200 {"status":"ok", ...}`.
- `bot`: has no public URL; Railway pings its private health port directly (`bot.railway.json`
  configures `healthcheckPath` — see `infra/railway/README.md` for why the bot's healthcheck is
  handled differently from the other three).
- `web`: `GET /` returning `200` is the healthcheck.
- `dashboard`: **`GET /` now returns a 308 redirect, not 200** (see §1's topology note) — a
  healthcheck configured to require exactly `200` on `/` will misreport this service as down. Both
  `render.yaml` and `infra/railway/dashboard.railway.json` now point `healthcheckPath` at
  `/icon.png` instead — a real static file, always 200, unaffected by the `/`/`/dashboard/*`-only
  redirect scope. Swap it for a real ops-console route once one exists.

Each service's **Deployments** tab shows the healthcheck result for the active deploy — a red X
there is the first place to look when something doesn't come up.

### 2.8 Logs

Each service's **Observability → Logs** tab streams stdout/stderr live and lets you search/filter.
`bot` and `api` log structured JSON (pino) — Railway's log viewer renders it readably. Logs never
contain message content, tokens, or secrets by design (see `docs/SECURITY.md`).

### 2.9 Redeploy and rollback

- **Redeploy** (same code, e.g. after a variable change): open the service → **Deployments** →
  **⋮** on the current deployment → **Redeploy**.
- **Rollback**: open the service → **Deployments** → find the last known-good deployment in the
  list → **⋮** → **Redeploy**. This redeploys that exact build; it does not touch the database. Only
  roll back a migration by hand if you're certain it caused the problem and you have a verified
  backup (see §8).
- Every push to `main` (once CI passes) triggers a fresh build+deploy automatically on all four
  services — this is the normal update path (§9).

## 3. ALTERNATIVE — Render Blueprint

Render's [Blueprint](https://render.com/docs/blueprint-spec) spec describes the whole stack in one
file. This repo ships `render.yaml` at the root — Render reads it automatically.

1. Push the repo to GitHub (already done) and make sure `render.yaml` is at the repo root (it is).
2. In the [Render dashboard](https://dashboard.render.com), click **New → Blueprint**, connect the
   repo, and Render parses `render.yaml` and shows you the services it will create: `api`,
   `dashboard`, `web` (all Docker web services), `bot` (a Docker **worker**, since it has no HTTP
   traffic to serve publicly), `pavisie-postgres` (managed Postgres), `pavisie-redis` (Render Key
   Value, Render's managed Redis-compatible store).
3. Render prompts you for every variable marked `sync: false` in the blueprint (the secrets — Discord
   token/client secret, `ENCRYPTION_KEY`, `SESSION_SECRET`, any integration keys, etc.) — fill them in on that
   screen. Variables wired with `fromDatabase`/`fromService` (Postgres/Redis connection strings, and
   cross-service URLs) are filled in automatically and need no action.
4. Click **Apply**. Render builds and deploys all five resources.
5. `api`'s `preDeployCommand: pnpm db:migrate` runs migrations before each deploy goes live, same
   idea as the Railway pre-deploy command in §2.5 — nothing extra to do.
6. `api` declares `healthCheckPath: /health`; Render won't route traffic to a new deploy until it
   passes.
7. Custom domains: each web service's **Settings → Custom Domains** — add `api.pavisie.com`,
   `app.pavisie.com`, `pavisie.com`/`www.pavisie.com` the same way, then add the CNAME/ALIAS
   records Render shows you at your registrar (same idea as §2.4).
8. Run `commands:register` and `set-avatar` once via **Shell** on the `bot` service (Render gives
   every service a **Shell** tab in its dashboard):
   ```
   pnpm commands:register
   pnpm --filter @pavisie/bot set-avatar
   ```

**Free-tier caveat**: Render's free web services spin down after inactivity and cold-start on the
next request. That's fine for `web` if you don't mind an occasional slow first load, but `bot` must
be an always-on **paid** worker — a bot that sleeps disconnects from Discord's gateway and stops
responding. Budget for at least one paid instance.

## 4. ALTERNATIVE — Any VPS with docker-compose, behind Caddy

For full control (or if you already run other services on a VPS), the existing `docker-compose.yml`
runs everything on one box. Put [Caddy](https://caddyserver.com/) in front for automatic TLS.

1. Provision a VPS (2 vCPU / 4GB RAM is comfortable headroom for all four services + Postgres +
   Redis at small-to-medium scale), install Docker + Docker Compose, and point the three DNS records
   (`pavisie.com`, `app.pavisie.com`, `api.pavisie.com`) at the VPS's IP address (`A`
   records) at your registrar.
2. Clone the repo onto the VPS, copy `.env.production.example` to `.env`, and fill in every secret
   (see §6 for the full table). Set `COOKIE_DOMAIN=.pavisie.com` and `TRUST_PROXY=1` (Caddy is the one
   reverse-proxy hop in front of `api` here too — see the callout in §2.3 for why this must be an exact hop
   count, not `true`). If you want donations enabled, also set `KOFI_URL` to your Ko-fi page URL (see §2.3).
3. `docker compose up -d --build` — this builds and starts `postgres`, `redis`, runs `migrate` once,
   then starts `bot`, `api`, `dashboard`, `web` (all `restart: unless-stopped`). The compose file
   already wires internal service hostnames (`postgres`, `redis`) for `DATABASE_URL`/`REDIS_URL` — do
   not point those at `localhost` on the host.
4. Install Caddy on the host (not in Docker, to keep TLS cert storage simple — either works) and use
   this `Caddyfile`, which reverse-proxies each hostname to the matching container port and gets TLS
   certificates from Let's Encrypt automatically:

   ```caddyfile
   pavisie.com, www.pavisie.com {
       reverse_proxy localhost:3003
   }

   app.pavisie.com {
       reverse_proxy localhost:3000
   }

   api.pavisie.com {
       reverse_proxy localhost:3001
   }
   ```

   Reload Caddy (`caddy reload` or `systemctl reload caddy`) after saving. Caddy handles the
   `www` → apex redirect itself if you'd rather split it into its own block with a `redir` directive;
   the combined block above just serves both from `web`.

5. Register commands and set the avatar from the host:
   ```
   docker compose run --rm api pnpm commands:register
   docker compose run --rm api pnpm --filter @pavisie/bot set-avatar
   ```
   (the `api` image has the full workspace installed, so it can run any workspace script — or build
   and run the `bot` image the same way).
6. Updating: `git pull && docker compose up -d --build` — this rebuilds changed images, re-runs
   `migrate`, and restarts the affected containers. See §9 for the full update procedure.

## 5. Cross-site cookies (only relevant if you skip custom domains)

Railway's and Render's default `*.up.railway.app` / `*.onrender.com` subdomains are on the Public
Suffix List, which makes the API and dashboard **cross-site** from the browser's point of view even
though they're both "yours." That breaks the default `SameSite=Lax` session cookie. If you're
testing on the platform's default domains before DNS is wired up, set `SESSION_COOKIE_SAMESITE=none`
on `api` (this also forces the cookie to be `Secure`, and the API refuses to boot with
`SESSION_COOKIE_SAMESITE=none` unless `API_BASE_URL` looks like `https://`). **Once you're on the
custom domains under the shared apex `pavisie.com`**, switch back to the default
`SESSION_COOKIE_SAMESITE=lax` (or just unset it) and set `COOKIE_DOMAIN=.pavisie.com` — this is
the recommended, permanent configuration and is what `.env.production.example` ships with. CSRF
protection (the `X-CSRF-Token` header plus the `DASHBOARD_URL`/`WEB_URL` Origin allowlist) applies in
both modes.

## 6. Environment variable reference

"Required?" = required for that app to boot in production. Optional integration vars are omitted
below when they're just "blank = feature disabled" — see `.env.production.example` for the full
list with comments; every var there is also documented in `docs/ARCHITECTURE.md` §4.

| Variable                                                                                                                                                                                                                                                     | Required?                | Which app(s)                                       | Where the value comes from                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                                                                                                                                                                                                                                   | Yes                      | all                                                | Literal `production`                                                                                                                                                           |
| `LOG_LEVEL`                                                                                                                                                                                                                                                  | No (defaults `info`)     | bot, api                                           | Literal `info` (or `debug`/`trace` when diagnosing)                                                                                                                            |
| `DATABASE_URL`                                                                                                                                                                                                                                               | Yes                      | bot, api                                           | Managed Postgres connection string (`${{Postgres.DATABASE_URL}}` on Railway, `fromDatabase` on Render, your own Postgres on a VPS)                                             |
| `REDIS_URL`                                                                                                                                                                                                                                                  | Yes                      | bot, api                                           | Managed Redis connection string (`${{Redis.REDIS_URL}}` on Railway, `fromService` on Render, your own Redis on a VPS)                                                          |
| `DISCORD_TOKEN`                                                                                                                                                                                                                                              | Yes                      | bot                                                | Discord Developer Portal → your application → **Bot** → Reset Token                                                                                                            |
| `DISCORD_CLIENT_ID`                                                                                                                                                                                                                                          | Yes                      | bot, api, web (as `NEXT_PUBLIC_DISCORD_CLIENT_ID`) | Discord Developer Portal → **General Information** → Application ID                                                                                                            |
| `DISCORD_CLIENT_SECRET`                                                                                                                                                                                                                                      | Yes                      | api                                                | Discord Developer Portal → **OAuth2** → Client Secret                                                                                                                          |
| `DISCORD_OAUTH_REDIRECT_URI`                                                                                                                                                                                                                                 | Yes                      | api                                                | `https://api.pavisie.com/auth/discord/callback` — must also be added in the Portal's OAuth2 redirect list, byte-for-byte                                                   |
| `ENCRYPTION_KEY`                                                                                                                                                                                                                                             | Yes                      | bot, api                                           | You generate it: `openssl rand -base64 32`                                                                                                                                     |
| `ENCRYPTION_KEY_PREVIOUS`                                                                                                                                                                                                                                    | Only during key rotation | bot, api                                           | The previous `ENCRYPTION_KEY` value, set temporarily — see `docs/SECURITY.md`                                                                                                  |
| `SESSION_SECRET`                                                                                                                                                                                                                                             | Yes                      | api                                                | You generate it: `openssl rand -base64 32`                                                                                                                                     |
| `API_PORT`                                                                                                                                                                                                                                                   | No (defaults `3001`)     | api                                                | Literal `3001`                                                                                                                                                                 |
| `API_BASE_URL`                                                                                                                                                                                                                                               | Yes                      | api                                                | `https://api.pavisie.com`                                                                                                                                                  |
| `DASHBOARD_URL`                                                                                                                                                                                                                                              | Yes                      | api                                                | `https://pavisie.com` — same value as `WEB_URL` now that the dashboard UI lives in `web` (CORS allowlist + OAuth post-login redirect target)                              |
| `WEB_URL`                                                                                                                                                                                                                                                    | Yes                      | api, web (server-side), dashboard (server-side)    | `https://pavisie.com` (CORS allowlist entry + brand links on api/web; redirect target for `dashboard`'s legacy `/` and `/dashboard/*` paths)                               |
| `NEXT_PUBLIC_API_URL`                                                                                                                                                                                                                                        | Yes                      | dashboard, web                                     | `https://api.pavisie.com`                                                                                                                                                  |
| `NEXT_PUBLIC_INVITE_PERMISSIONS`                                                                                                                                                                                                                             | No                       | web                                                | Integer permission bitfield — see `docs/invite.json` (generated)                                                                                                               |
| `NEXT_PUBLIC_SUPPORT_SERVER_URL`                                                                                                                                                                                                                             | No                       | web                                                | Your support Discord server invite link, if you have one                                                                                                                       |
| `COOKIE_DOMAIN`                                                                                                                                                                                                                                              | Recommended              | api                                                | `.pavisie.com`                                                                                                                                                             |
| `SESSION_COOKIE_SAMESITE`                                                                                                                                                                                                                                    | No (defaults `lax`)      | api                                                | `lax` on custom domains; `none` only if temporarily using platform default subdomains — see §5                                                                                 |
| `TRUST_PROXY`                                                                                                                                                                                                                                                | Yes in production        | api                                                | `1` — an integer hop count, not a boolean. All three cloud paths put exactly one reverse proxy/load balancer in front of the API. Never `true` (see the §2.3 callout).         |
| `E2E_TEST_MODE`                                                                                                                                                                                                                                              | Must be unset/`false`    | api                                                | Leave unset. The API also hard-refuses this in production regardless.                                                                                                          |
| `BOT_OWNER_IDS`                                                                                                                                                                                                                                              | Recommended              | bot                                                | Your (and any co-owner's) Discord user id — right-click your name in Discord with Developer Mode on → Copy User ID                                                             |
| `DEV_GUILD_ID`                                                                                                                                                                                                                                               | No                       | bot                                                | A test server's id, temporarily, for instant command registration while testing                                                                                                |
| `BOT_HEALTH_PORT`                                                                                                                                                                                                                                            | No (defaults `3002`)     | bot                                                | Literal `3002`                                                                                                                                                                 |
| `ENABLE_GUILD_MEMBERS_INTENT`                                                                                                                                                                                                                                | Recommended `true`       | bot                                                | Enabled in Discord Developer Portal → **Bot** → Privileged Gateway Intents → Server Members Intent, then set `true` here to match                                              |
| `ENABLE_MESSAGE_CONTENT_INTENT`                                                                                                                                                                                                                              | No (default `false`)     | bot                                                | Only after Discord approves the privileged intent for your bot (or while under 100 servers, which doesn't require approval) — enable in the Portal first, then set `true` here |
| `PUBLIC_WEBHOOK_BASE_URL`                                                                                                                                                                                                                                    | Yes if using webhooks    | api                                                | `https://api.pavisie.com`                                                                                                                                                  |
| `KOFI_URL`                                                                                                                                                                                                                                                      | No (donations are optional)      | api                                                | Full Ko-fi page URL, e.g. `https://ko-fi.com/yourname`. Leave blank to disable the donate page.                                                                              |
| `CAPTCHA_PROVIDER` (`hcaptcha`/`turnstile`) + that provider's `*_SITE_KEY`/`*_SECRET`                                                                                                                                                                       | No (optional; powers the `roles` plugin's verification mode only) | api                                                | Cloudflare Turnstile or hCaptcha's own dashboard. Donations are now handled by Ko-fi and do not require CAPTCHA here. |
| Other integration keys (`TWITCH_*`, `YOUTUBE_API_KEY`, `GITHUB_WEBHOOK_SECRET`, `REDDIT_*`, `STEAM_API_KEY`, `GOOGLE_*`, `MICROSOFT_*`, `NOTION_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPL_API_KEY`, `OPENWEATHERMAP_API_KEY`)                       | No                       | api, bot                                           | Each provider's own developer console. Blank = that feature stays disabled; nothing else is affected.                                                                          |

## 7. Secret rotation runbook

Rotate a secret whenever you suspect it leaked (committed by accident, shown in a screenshot, a
teammate who had it leaves, etc.) — don't wait for evidence of misuse. Full incident-response
framing is in `docs/SECURITY.md`; this is the mechanical "how."

- **Discord bot token**: Discord Developer Portal → your application → **Bot** → **Reset Token**
  (this immediately invalidates the old token — the bot goes offline the moment you do this). Copy
  the new token into `DISCORD_TOKEN` on the `bot` service and redeploy/restart it. Do this during a
  maintenance window if you can; there's no way to reset without a brief bot outage.
- **Discord OAuth client secret**: Portal → **OAuth2** → **Reset Secret**. Update
  `DISCORD_CLIENT_SECRET` on `api` and restart it. Existing dashboard sessions are unaffected (the
  client secret is only used for the OAuth token exchange, not per-request); new logins fail until
  you update it.
- **`SESSION_SECRET`**: generate a new value (`openssl rand -base64 32`), set it on `api`, restart.
  This immediately invalidates every existing signed session cookie — every logged-in dashboard user
  is signed out and has to log in again. There's no partial/rolling option for this one.
- **`ENCRYPTION_KEY`**: see the dedicated walkthrough in `docs/SECURITY.md` — it needs the
  `ENCRYPTION_KEY_PREVIOUS` two-step and the re-encryption script (`pnpm --filter @pavisie/database
reencrypt:secrets`), not just a variable swap, or every already-encrypted OAuth token, webhook
  secret, and stored AI API key becomes unreadable.
- **Any integration key** (Twitch/YouTube/Reddit/Steam/Google/Microsoft/OpenAI/Anthropic/etc.):
  roll it in that provider's console, update the variable on `api` (and `bot` if that integration's
  jobs run there), restart.
- **Dashboard session invalidation** (force everyone out without rotating `SESSION_SECRET` — e.g. you
  just want a clean slate, not a full secret rotation): connect to Redis and delete every
  `pavisie:session:*` key:
  ```
  redis-cli --scan --pattern 'pavisie:session:*' | xargs -r redis-cli del
  ```
  (On Railway/Render, open a shell on a service that has `REDIS_URL` set and run `redis-cli -u
"$REDIS_URL" ...` instead, or use the platform's Redis data browser if it has one.)

## 8. Backups

- **Postgres**: use your provider's managed snapshot/point-in-time-recovery feature as the primary
  backup (Railway and Render both offer this on their Postgres plans — check current plan details,
  since free tiers usually have shorter retention or none). In addition, run periodic `pg_dump`
  backups you control and store somewhere separate from the platform (`pg_dump $DATABASE_URL -Fc -f
pavisie-$(date +%Y%m%d).dump`, restore with `pg_restore`). **Test a restore periodically** — an
  untested backup is not a backup.
- **Redis**: treat it as ephemeral cache/queue/session state, not a system of record. Losing it logs
  everyone out and drops in-flight jobs, but no durable data is lost — nothing in Redis needs a
  backup strategy.

## 9. Monitoring

There's no dedicated monitoring dashboard shipped yet (see `docs/ROADMAP.md`) — for now, monitoring
means checking the health endpoints and logs:

- `GET https://api.pavisie.com/health` — should always return `200`.
- `bot`'s private health port (`BOT_HEALTH_PORT`) — Railway/Render check this automatically per
  §2.7/§3; on a VPS, `docker compose ps` shows each service's healthcheck status, or curl it directly
  from inside the container network.
- `GET https://pavisie.com/` — should return `200`.
- `GET https://app.pavisie.com/` — now expected to return a `308` redirect to
  `https://pavisie.com/`, not `200` (see §1's topology note); update any existing uptime check
  that asserted `200` here, or point it at `https://pavisie.com/dashboard/123/automod`-style
  legacy link instead and assert it redirects rather than 404s.
- Set up an external uptime check (UptimeRobot, Better Uptime, or similar — any free tier is fine)
  against those four URLs if you want to be notified before a user tells you something's down.
- `GET https://api.pavisie.com/docs` (the Swagger UI) is expected to 404 in production — it's registered
  only when `NODE_ENV !== 'production'`, so the exact request shapes of public endpoints aren't published to
  anyone who looks. It still works locally/in dev.
- Watch each platform's built-in resource graphs (CPU/memory) for `bot` and `api` — a slow creep
  toward the memory limit over days usually means a leak worth investigating, not something to
  ignore.

## 10. Updating

1. Push to `main` (or merge a PR into it).
2. GitHub Actions CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, migration-against-a-
   fresh-database check, and the build. **This is the gate** — a red CI run should block a deploy;
   Railway/Render deploy from the same commit CI just validated, so a broken commit that somehow
   lands on `main` will still build, but you'll have caught it in CI first.
3. Railway and Render both auto-deploy on push to the branch you connected (`main`) once CI-equivalent
   build steps in their own pipeline succeed — no manual redeploy needed for the common case.
4. Migrations run automatically via the pre-deploy command (Railway §2.5, Render §3.5) before the new
   `api`/`bot` code goes live. On a VPS, `git pull && docker compose up -d --build` does the
   equivalent (rebuild → `migrate` service reruns → restart `bot`/`api`/`dashboard`/`web`).
5. `bot` briefly disconnects and reconnects to Discord's gateway on restart — this is normal and not
   visible to users beyond the bot showing "connecting" for a few seconds in server member lists on
   some clients. `api` and `dashboard` are stateless, so a rolling restart (if your platform does
   one) causes no downtime; a hard restart causes a few seconds of connection errors for anyone mid
   -request.

## 11. Rollback

1. **Railway**: service → **Deployments** → find the last known-good build → **⋮** → **Redeploy**.
   **Render**: service → **Events**/**Deploys** → **Rollback** to a previous deploy. **VPS**:
   `git checkout <previous-good-commit>` (or re-pull a previously tagged image) then
   `docker compose up -d --build`.
2. This rolls back application code only — it does not touch the database.
3. Only roll back a database migration if you're confident the new migration caused the problem
   **and** you have a verified backup. Prisma migrations are forward-only by default: write a
   compensating migration rather than hand-editing/reverse-applying SQL unless you're certain it's
   safe. Re-run `pnpm db:migrate` only if you've added a compensating migration — otherwise leave the
   schema as-is and let only the application code be what rolled back.

## 12. One bot process (no sharding in MVP)

Run exactly one instance of `apps/bot`. Discord doesn't require sharding until a bot is in roughly
2,500+ guilds (the gateway itself signals a `Sharded: true` requirement at that point). If you
approach that threshold, introduce `discord.js`'s `ShardingManager` and move per-shard state
(in-memory caches only, never application data — the database/Redis layers are already shard-safe
since all real state lives outside the bot process). Don't add sharding speculatively.

## 13. Scaling workers and the API

`apps/bot` hosts BullMQ job workers in-process alongside the Discord gateway connection. If job
volume grows past what one process handles promptly, split workers into a dedicated process (reuse
`apps/bot/src/workers.ts` pointed at the same Redis, without calling `client.login`) and scale that
independently — this is a code change, not a config toggle, so it's future work rather than something
to reach for now. `apps/api` is stateless (all session state lives in Redis) and can already be
scaled horizontally on any of the three platforms above without special configuration — just increase
the instance/replica count.

## 14. Rough monthly cost guidance

**Check current pricing before committing** — this is a rough starting point as of when this doc was
written, not a quote:

- **Railway**: usage-based. A small always-on `bot` + `api` + `dashboard` + `web` plus small managed
  Postgres and Redis typically lands in the **$15–35/month** range for a bot serving a modest number
  of servers, scaling up with traffic and database size. Railway's pricing page has a calculator.
- **Render**: Blueprint with paid instances for all four services (required for `bot`; recommended
  for the others to avoid cold starts) plus a small Postgres and Key Value plan is typically in a
  similar **$20–40/month** range; Render's free tier can host `api`/`dashboard`/`web` if you accept
  cold starts, but `bot` cannot use a free/sleeping instance.
- **VPS**: a $6–12/month VPS (1–2 vCPU, 2–4GB RAM) from any provider comfortably runs all five
  containers (`postgres`, `redis`, `bot`, `api`, `dashboard`, `web`) for small-to-medium load; add the
  cost of your own backup storage and any monitoring service. This is the cheapest floor but puts TLS,
  OS updates, and restarts on you.

Real cost depends heavily on server count, message volume (job/queue throughput), and how much
history you retain in Postgres. Re-check each platform's current published pricing before deciding.
