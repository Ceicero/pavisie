# Troubleshooting

Real problems, real fixes. If something here doesn't match what you're seeing, ask in the
**Pavisie support Discord server** (linked on the website's `/support` page and footer, and in the
dashboard) — check `infra/DEPLOYMENT.md` (production operations) or open an issue with the exact
error text and which of `bot` / `api` / `dashboard` / `web` printed it.

- [The bot won't start](#the-bot-wont-start)
- [Slash commands aren't showing up in Discord](#slash-commands-arent-showing-up-in-discord)
- [`+` prefix commands do nothing](#-prefix-commands-do-nothing)
- ["Missing Permissions" errors / commands fail on specific users](#missing-permissions-errors--commands-fail-on-specific-users)
- [Dashboard login loop (keeps sending you back to the login page)](#dashboard-login-loop-keeps-sending-you-back-to-the-login-page)
- [403 Forbidden when opening a server in the dashboard](#403-forbidden-when-opening-a-server-in-the-dashboard)
- [Webhooks (GitHub / Twitch) aren't arriving](#webhooks-github--twitch-arent-arriving)
- [Prisma migration errors](#prisma-migration-errors)
- [Redis connection errors](#redis-connection-errors)
- [Windows-specific notes](#windows-specific-notes)
- [Railway-specific notes](#railway-specific-notes)

---

## The bot won't start

Read the last few lines the process printed before it exited — `apps/bot` fails fast with a clear
message rather than hanging, so the cause is almost always right there.

**"Missing required environment variable(s): DISCORD_TOKEN"** (or `DATABASE_URL` / `REDIS_URL` /
`DISCORD_CLIENT_ID`)
→ One of the required values in your `.env` is blank. Open `.env` in the repo root, fill it in, and
restart. See the README's [local setup](README.md#local-setup) section for where each value comes
from.

**Bot process crashes immediately with a Discord.js `AuthenticationError` / "401: Unauthorized"**
→ `DISCORD_TOKEN` is wrong or was reset. In the [Discord Developer Portal](https://discord.com/developers/applications) →
your application → **Bot** tab → **Reset Token** → copy the new value into `.env` as
`DISCORD_TOKEN`. Tokens are shown only once at generation time — if you don't have it saved
anywhere, resetting is the only way back in.

**Error mentions `"Used disallowed intents"` (sometimes shown as a Discord gateway close code
`4014`)**
→ The bot is asking the gateway for a privileged intent that isn't turned on for your application
in the Developer Portal. Two places must agree:

1. Developer Portal → your application → **Bot** tab → **Privileged Gateway Intents** — toggle on
   whichever the error is about (**Server Members Intent** and/or **Message Content Intent**).
2. Your `.env` — `ENABLE_GUILD_MEMBERS_INTENT=true` and/or `ENABLE_MESSAGE_CONTENT_INTENT=true`
   must match what you turned on in the Portal.

Message Content additionally requires Discord's own approval once a bot is in 100+ servers — see
the README's [Discord Developer Portal setup](README.md#discord-developer-portal-setup) section.
Below that threshold it works immediately once you flip the toggle.

**Bot starts but never goes "ready" / hangs on "logging in"**
→ Usually a network problem (corporate proxy, firewall) blocking outbound access to Discord's
gateway, or `DISCORD_TOKEN` is for the wrong application. Check the token is copied from the same
application whose **Application ID** matches your `DISCORD_CLIENT_ID`.

**`ECONNREFUSED` connecting to Postgres or Redis on startup**
→ See [Redis connection errors](#redis-connection-errors) below — the same diagnosis applies to
Postgres. Make sure `docker compose up -d postgres redis` (or your local installs) are actually
running before starting the bot.

---

## Slash commands aren't showing up in Discord

Commands must be **registered** with Discord separately from the bot being online — starting the
bot does not register anything.

1. Run `pnpm --filter @pavisie/bot register`.
2. Check whether `DEV_GUILD_ID` is set in your `.env`:
   - **Set** → commands register to that one server only, and show up **instantly**. Make sure
     you're testing in that exact server.
   - **Unset** → commands register **globally**, which can take up to **one hour** to propagate to
     every server. This is the #1 cause of "I registered but nothing showed up" — it's not broken,
     it's just slow. For local development, set `DEV_GUILD_ID` to your test server's ID so you get
     instant updates instead of waiting.
3. Check the bot was actually invited with the `applications.commands` scope, not just `bot`. If
   you built your own invite URL by hand and left this scope out, re-invite the bot using the full
   URL from the README's [invite URL](README.md#invite-url) section (which always includes both
   scopes) — Discord won't show slash commands for a bot that was never granted this scope, even if
   registration succeeded.
4. If commands changed (renamed, added, removed) and old ones still show up or new ones don't, re-run
   `pnpm --filter @pavisie/bot register` — Discord doesn't diff automatically; you have to push the
   update.

---

## `+` prefix commands do nothing

The `+` prefix command layer (e.g. `+help`, `+mod ban @user spam`) silently fails when:

**1. Message Content Intent is not enabled**
→ The `+help` command is typed, but nothing happens — no error, no reply. The bot sees the message but Discord has blanked out its content because the Message Content privileged intent is not enabled. Fix:
   1. Discord Developer Portal → your application → **Bot** tab → **Privileged Gateway Intents** → toggle **ON** for **Message Content Intent**.
   2. Your deployment's `.env` or environment variables → set `ENABLE_MESSAGE_CONTENT_INTENT=true`.
   3. Both must be in place. Reboot the bot after either change. Slash commands will still work fine regardless (they don't require this intent).

**2. `ENABLE_MESSAGE_CONTENT_INTENT` is not `true` in the deployment**
→ Same effect as above. Check your Railway / Render variables or your local `.env` and set `ENABLE_MESSAGE_CONTENT_INTENT=true`, then restart the bot.

**3. The bot lacks permission in that channel**
→ Check the channel's permissions for the bot's role: it needs **View Channel** and **Send Messages**. Re-invite the bot using the invite link in the README (which grants the full least-privilege permission set), or manually grant those two permissions in Server Settings → Roles → the bot's role → permissions.

**4. The plugin owning that command is disabled for the server**
→ Type `/plugin status` (slash form — that always works) to see which plugins are enabled. Use `/plugin enable <plugin-id>` to turn on the plugin the command belongs to. The `+` form won't work until the plugin is enabled, and neither will the `/` form.

**Slash commands keep working regardless.** If `+help` fails but `/help` still works, the problem is one of the above — most likely the Message Content Intent.

---

## "Missing Permissions" errors / commands fail on specific users

**A command replies with a permission error even though you invited the bot with the right
permissions**
→ Discord permissions are also governed by **role hierarchy**, separately from the permission
bits granted at invite time. Open your server's **Server Settings → Roles** and make sure the
bot's own role is positioned **above** any role it needs to act on (e.g. to timeout or kick a
member, the bot's role must be higher than that member's highest role). Drag the bot's role up the
list if needed.

**A moderator can't act on a specific member ("target is higher than you" / "target is higher than
the bot")**
→ This is intentional, not a bug: Pavisie checks that the acting moderator, and the bot itself, both
outrank the target before allowing kick/ban/timeout/role actions. It also always refuses to act on
the server owner, the bot itself, or another bot owner. Raise the acting moderator's role (or lower
the target's), or have someone who does outrank the target perform the action.

**`/permissions audit` shows a permission as missing**
→ Re-invite the bot using the current invite link (see the README), or manually grant the listed
Discord permission to the bot's role in **Server Settings → Roles** → the bot's role → permissions
tab. `docs/PERMISSIONS.md` explains exactly what each permission is for and what happens if you
leave it off — most features degrade gracefully rather than breaking everything.

**`/setup status` — did I need to run the wizard?**
→ No. `/setup status` says _complete (configured via dashboard or /config)_ when staff roles and a
mod-log channel exist even if the wizard was never run; it only says _incomplete_ (listing what's
missing) when one of those is actually absent. Set them under the dashboard's **Settings** page or
run `/setup wizard` — either way counts.

---

## Dashboard login loop (keeps sending you back to the login page)

This is almost always one of four values not matching each other exactly. Check, in this order:

1. **`DISCORD_OAUTH_REDIRECT_URI`** (api's `.env`) must be **byte-for-byte identical** to a redirect
   URI registered in the Developer Portal → **OAuth2** tab → **Redirects**. A trailing slash, `http`
   vs `https`, or a wrong port will silently break the callback.
2. **`DASHBOARD_URL`** (api's `.env`) must exactly match the dashboard's real origin — it's both the
   CORS allowlist entry and the post-login redirect target. If the dashboard is actually running on
   `http://localhost:3000` but `DASHBOARD_URL` says something else, the redirect after login goes to
   the wrong place and looks like nothing happened.
3. **Cookie domain** — in production, if `api.yourdomain.com` and `app.yourdomain.com` don't share a
   registered parent domain in `COOKIE_DOMAIN` (e.g. `COOKIE_DOMAIN=.yourdomain.com`), the session
   cookie set by the API isn't visible to the dashboard and every page load looks logged-out. Locally
   (both on `localhost`), leave `COOKIE_DOMAIN` unset — don't set it for local dev.
4. **SameSite / cross-site hosting** — if api and dashboard are on two _different_ platform-provided
   subdomains that don't share a custom domain (e.g. one on `*.up.railway.app` and one on
   `*.onrender.com`, or you haven't set up custom domains yet), the browser treats them as
   cross-site and blocks the cookie under the default `SESSION_COOKIE_SAMESITE=lax`. Either put both
   behind one custom domain (recommended — see the README's production section) or set
   `SESSION_COOKIE_SAMESITE=none` (this also forces `API_BASE_URL` to be `https://` — the API
   refuses to start otherwise).

If none of those are it: open your browser's dev tools → Application/Storage → Cookies, log in
again, and check whether a `sid` cookie actually gets set on the api's domain at all. If it never
appears, the API request is failing before it gets to set a cookie — check the api process's logs
for the actual error.

---

## 403 Forbidden when opening a server in the dashboard

The dashboard only lets you configure servers where **you personally** have Discord's **Manage
Server** permission (or you're the server owner) — this is checked fresh against your real Discord
roles, not just "the bot is in this server." If you can see the server in the guild selector but get
a 403 opening it, ask a server admin to either grant you Manage Server or make the change themselves.
Being a bot owner (`BOT_OWNER_IDS`) does not bypass this — that setting only affects bot-owner-only
Discord _commands_, not dashboard access.

---

## Webhooks (GitHub / Twitch) aren't arriving

The guild-facing Stripe integration connector (and its `/webhooks/stripe` endpoint) was removed
2026-09-02 — see `docs/ARCHITECTURE.md` §18a. This section now covers the two remaining inbound
webhook sources.

1. **The API must be reachable from the public internet** at the URL you configured with the
   provider — `localhost` is never reachable from GitHub/Twitch's servers. In production, this is
   `https://api.yourdomain.com/webhooks/...` (`PUBLIC_WEBHOOK_BASE_URL` / `API_BASE_URL`).
2. **Signing secrets must match.** Each provider signs its webhook payloads, and Pavisie verifies
   the signature before doing anything with the request — a wrong or missing secret means every
   delivery is silently rejected as unverified (check the api process's logs; it logs a rejection,
   never the payload itself). Re-copy the secret from the provider's webhook settings into the
   matching `.env` variable (`GITHUB_WEBHOOK_SECRET`, `TWITCH_EVENTSUB_SECRET`) exactly —
   regenerating the endpoint on the provider's side usually issues a new secret.
3. **Check the provider's own delivery log** (GitHub → repo Settings → Webhooks → Recent
   Deliveries) — it shows the HTTP status Pavisie's API returned, which narrows this down fast: a
   `401`/`400` is almost always the signature/secret problem above; a connection failure/timeout
   means the URL isn't reachable at all (step 1); a `5xx` means the API errored after verifying the
   signature — check the api logs for that request.

---

## Prisma migration errors

**`P1001: Can't reach database server`**
→ `DATABASE_URL` is wrong, or Postgres isn't running/reachable yet. Confirm the host/port/credentials
and that Postgres has finished starting (`docker compose ps` should show it `healthy`, not just
`running`).

**Migration fails partway with a constraint or type error against an existing database**
→ Don't run `migrate dev` against a database with real data — it's a development tool that can
generate destructive migrations. Use `pnpm db:migrate` (`prisma migrate deploy`), which only applies
already-committed migrations and never generates new ones. If a specific migration genuinely
conflicts with your data, that needs a hand-written compensating migration — don't try to edit a
migration file that has already been applied elsewhere.

**"Migration already applied" / drift errors on a database you're not sure about**
→ Run `pnpm --filter @pavisie/database exec prisma migrate status` to see exactly what Prisma
thinks has and hasn't been applied before doing anything destructive.

**Local dev database is in a state you don't care about preserving**
→ Easiest fix is often to drop it and start clean: stop the app, drop/recreate the `pavisie`
database (or `docker compose down -v` to also wipe the Postgres volume), then `pnpm db:migrate`
again from zero.

---

## Redis connection errors

**`ECONNREFUSED 127.0.0.1:6379`** (or your `REDIS_URL` host/port)
→ Redis isn't running, or `REDIS_URL` points somewhere else. With Docker: `docker compose up -d
redis` and confirm `docker compose ps` shows it healthy. Without Docker: make sure a local Redis
server is actually started and `REDIS_URL` matches its host/port (default
`redis://localhost:6379`).

**Sessions/logins mysteriously stop working, or rate limits behave strangely**
→ Redis holds sessions, caches, cooldowns, and queues — it's not optional, and treating it as "just
cache" that's fine to skip will break login and every rate-limited command. If Redis restarted or
was flushed, everyone gets logged out and in-flight background jobs are lost, but no permanent data
is lost (Postgres is the source of truth).

**In production**: Redis being unreachable at boot causes `bot`/`api` to fail the same way a missing
env var does — check your managed Redis add-on's status page and that `REDIS_URL` was actually
injected into the service's environment.

---

## Windows-specific notes

- **`next build` standalone output** (`output: 'standalone'`, what `Dockerfile.dashboard` and
  `Dockerfile.web` consume) needs filesystem symlink privileges that a plain Windows dev account
  usually doesn't have, so it's **auto-skipped on Windows** — set `NEXT_OUTPUT_STANDALONE=true` to
  force it (only useful if you've enabled Developer Mode / symlink privileges) or just build inside
  Docker/WSL2/CI instead, which is what you want for a real deploy anyway.
- Local development (`pnpm dev`, `docker compose up`) works the same on Windows as anywhere else —
  the standalone-build limitation only affects producing a deployable image locally.
- Use the **PowerShell** or **Git Bash** examples in this repo's docs as given; Windows `cmd.exe`
  doesn't understand `export VAR=value` or `$VAR` — use `$env:VAR = "value"` in PowerShell instead.
- `openssl` (used to generate `ENCRYPTION_KEY`/`SESSION_SECRET`) ships with Git for Windows — run the
  `openssl rand -base64 32` commands from **Git Bash**, not PowerShell, unless you've separately
  installed OpenSSL for Windows.

---

## Railway-specific notes

- **Four separate services, one repo.** Each of `bot`, `api`, `dashboard`, `web` is its own Railway
  service pointed at the same GitHub repo with **Root Directory** `/` and its own **Dockerfile
  Path** (`infra/docker/Dockerfile.bot`, `.api`, `.dashboard`, `.web`). Don't try to run all four in
  one service.
- **Reference managed Postgres/Redis with Railway's variable syntax**, not a hand-typed connection
  string: `DATABASE_URL=${{Postgres.DATABASE_URL}}` and `REDIS_URL=${{Redis.REDIS_URL}}` on the
  `bot`/`api` services, after adding the Postgres and Redis plugins to the project.
- **Run migrations before the app serves traffic.** Set `pnpm db:migrate` as the `api` service's
  pre-deploy command, or run it once manually with `railway run pnpm db:migrate` after the first
  deploy. A deploy that starts serving before migrations run will error on every database query.
- **Public domains**: generate a Railway public domain for `api`, `dashboard`, and `web` (Settings →
  Networking → Generate Domain), or attach your own custom domains (recommended — see the README's
  [production deployment](README.md#production-deployment) section for why a shared custom domain
  avoids cross-site cookie issues). Whichever URLs you end up with must be reflected back into
  `DISCORD_OAUTH_REDIRECT_URI` (Developer Portal + `.env`), `DASHBOARD_URL`, `API_BASE_URL`,
  `WEB_URL`, and the matching `NEXT_PUBLIC_*` build-time variables — Railway env var changes to
  `NEXT_PUBLIC_*` values require a redeploy of `dashboard`/`web` to take effect, since Next.js bakes
  them in at build time.
- **Free/hobby tier services can sleep.** A Discord bot needs to stay connected to the gateway
  continuously — make sure the `bot` service is on an always-on plan, not a tier that sleeps on
  inactivity, or it will silently go offline between messages.
- **Healthchecks**: the `bot` service's healthcheck should hit its `BOT_HEALTH_PORT` (default
  `3002`) `/health` path; `api` uses `/health`; `dashboard`/`web` use `/`. Railway restarts a service
  that fails its healthcheck, so a wrong port here shows up as a crash-looping service.

See `infra/DEPLOYMENT.md` for the full production operations guide (backups, log shipping, rollback)
and `infra/railway/README.md` for the exact Railway click-path end to end.
