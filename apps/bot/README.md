# @pavisie/bot

The Discord gateway process: logs into the bot account, loads every plugin from `@pavisie/plugins`, routes slash/context-menu/autocomplete/component interactions, runs BullMQ workers for plugin background jobs and the shared `bot-actions` queue, upserts `Guild` rows on join/leave, and serves a tiny `/health` endpoint.

See `docs/ARCHITECTURE.md` §9 for the design this implements, and `docs/SPEC.md` for product requirements.

## Layout

```
src/
  index.ts              bootstrap: env → prisma/redis → registry → client → load plugins → login → workers → health → shutdown
  client.ts              builds the single discord.js Client
  register.ts             CLI: registers/clears slash & context-menu commands with Discord
  workers.ts               starts a BullMQ Worker for every plugin's declared job queue
  lib/redis-options.ts      parses REDIS_URL into ioredis options for BullMQ (local helper; not in packages/*)
  host/
    context.ts              builds one PluginContext per plugin
    host-service.ts          implements ServiceMap['host'] (cross-plugin/host-level operations admin needs)
    loader.ts                loads every plugin: host service, contexts, migrations, onLoad, events, components, commands, repeatable jobs
    router.ts                interactionCreate dispatch: availability/enablement/requirement/cooldown checks → execute
    permissions.ts            pure requirement-evaluation helpers (staffLevel/discordPermissions/botOwnerOnly/cooldown keys) + discord.js-dependent wrappers
    health.ts                 GET /health HTTP server
    bot-actions.ts             BullMQ Worker for the shared 'bot-actions' queue (dashboard/host → bot one-off requests)
    __tests__/                 unit tests (no live gateway)
```

## Running

Everything is read from the repo-root `.env` (copy `.env.example` if you haven't already). At minimum you need:

```
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
```

Postgres and Redis must already be running and migrated (`pnpm db:migrate` from the repo root) before starting the bot.

```bash
pnpm --filter @pavisie/bot dev      # tsx watch
pnpm --filter @pavisie/bot start    # tsx (prod-equivalent, no watch)
```

The process fails fast with a clear message (and a non-zero exit code) if `DISCORD_TOKEN`, `DATABASE_URL`, `REDIS_URL`, or `DISCORD_CLIENT_ID` is missing — it never hangs waiting on a connection it can't make.

### Registering commands

Discord does not pick up command changes automatically — run this after adding, renaming, or removing a command:

```bash
pnpm --filter @pavisie/bot register              # DEV_GUILD_ID if set, else global
pnpm --filter @pavisie/bot register --guild <id>  # register to one guild (updates instantly — good for local dev)
pnpm --filter @pavisie/bot register --global      # register globally (can take up to an hour to propagate)
pnpm --filter @pavisie/bot register --clear       # clear commands from the resolved target instead of registering
```

Set `DEV_GUILD_ID` in `.env` during development so plain `pnpm --filter @pavisie/bot register` updates your test server instantly instead of registering globally.

### Health check

`GET http://localhost:<BOT_HEALTH_PORT>/health` (default port `3002`) returns:

```json
{
  "status": "ok",
  "uptime": 1234,
  "guilds": 3,
  "ws": 42,
  "plugins": { "admin": { "status": "ok" }, "moderation": { "status": "disabled" }, ... }
}
```

Used by the Docker healthcheck (`infra/docker/Dockerfile.bot`) and safe to poll manually — it returns no sensitive data and needs no auth.

## Environment variables this process reads

See `.env.example` for the full documented list. The ones that specifically affect bot behavior:

| Variable                                                                                          | Effect                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`                                                              | required to boot                                                                                                                                                           |
| `DATABASE_URL`, `REDIS_URL`                                                                       | required to boot                                                                                                                                                           |
| `BOT_OWNER_IDS`                                                                                   | comma-separated user ids; floored at `admin` staff level everywhere, and required for `botOwnerOnly` commands                                                              |
| `DEV_GUILD_ID`                                                                                    | default target for `register` (instant guild-scoped updates instead of global)                                                                                             |
| `BOT_HEALTH_PORT`                                                                                 | health server port, default `3002`                                                                                                                                         |
| `ENABLE_MESSAGE_CONTENT_INTENT` / `ENABLE_GUILD_MEMBERS_INTENT` / `ENABLE_GUILD_PRESENCES_INTENT` | privileged intents — only enable after Discord approval/eligibility; plugins that need one degrade gracefully (not crash) when it's off, per `PluginRegistry.availability` |

## What to test by hand after a change

1. **Boots and logs in**: `pnpm --filter @pavisie/bot dev`, confirm `"bot ready"` logs with a guild count.
2. **Commands respond**: run `/setup status`, `/config view`, `/plugin list`, `/permissions audit`, `/health` in a server the bot is in — each should reply ephemerally with an embed, not an error.
3. **Permission gating**: try an admin-only command (e.g. `/plugin enable`) as a non-staff member — expect a clear "you need at least admin staff level" ephemeral reply, not a crash or a silent no-op.
4. **Plugin enable/disable**: `/plugin disable <id>` then try one of that plugin's commands — expect "this plugin is disabled" rather than the command running.
5. **Health endpoint**: `curl http://localhost:3002/health` while the bot is running — expect `"status":"ok"` and a `plugins` object listing every plugin.
6. **Missing token**: temporarily unset `DISCORD_TOKEN` and run `pnpm --filter @pavisie/bot start` — it should print a clear "Missing required environment variable(s): DISCORD_TOKEN" message and exit immediately (not hang).

## Tests

```bash
pnpm --filter @pavisie/bot test
```

Covers requirement evaluation (`staffLevel` vs `discordPermissions` OR semantics, `botOwnerOnly`, cooldown/rate-limit key derivation) and component custom-id routing (unknown id, kind mismatch, `ownerOnly` rejection, correct dispatch with parsed args) — all against in-memory fakes, no live Discord gateway or database.
