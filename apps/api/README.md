# @pavisie/api

Fastify 5 REST API for the Pavisie dashboard: Discord OAuth + sessions, guild/plugin config, moderation,
automod, logging, tickets, roles, engagement, community, integrations (OAuth + inbound webhooks), AI settings,
analytics, and privacy/data-retention endpoints. See `docs/ARCHITECTURE.md` §10 for the binding design.

## Running

```bash
pnpm --filter @pavisie/api dev     # tsx watch src/index.ts
pnpm --filter @pavisie/api start   # tsx src/index.ts (prod)
```

Requires `DATABASE_URL`, `REDIS_URL`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`,
`ENCRYPTION_KEY`, `DISCORD_OAUTH_REDIRECT_URI`, `DASHBOARD_URL` (see repo-root `.env.example`). The process
fails fast with a clear message if any of those are missing.

Swagger UI is served at `GET /docs` once the server is running; the raw OpenAPI JSON is at `GET /docs/json`.

## Scripts

```bash
pnpm --filter @pavisie/api typecheck
pnpm --filter @pavisie/api test
pnpm --filter @pavisie/api lint
pnpm --filter @pavisie/api openapi:export   # writes docs/openapi.json from a fake-backed app instance
```

## Architecture

- `src/index.ts` — process bootstrap: `loadEnv` → `requireEnv` → `buildApp()` → `listen(0.0.0.0:API_PORT)` →
  graceful shutdown on `SIGTERM`/`SIGINT`.
- `src/app.ts` — `buildApp(deps?)` builds (but doesn't start) the Fastify instance. Accepts injected
  `{ prisma, redis, queues }` so tests never touch real Postgres/Redis/BullMQ (see `test/helpers/build-test-app.ts`).
- `src/lib/` — session/CSRF/Discord-OAuth/guild-access/audit/queues/config-store/schemas/CSV/zod→JSON-Schema/
  automod-schemas/integration-provider helpers. Nothing here talks to Discord's gateway — this process never
  connects a bot client, only Discord's REST/OAuth endpoints via `fetch`.
- `src/routes/` — one file per feature, matching ARCHITECTURE.md §10's route list. Every guild-scoped route
  file is registered under the `/guilds` prefix and defines its own `/:guildId/...` sub-paths; `auth`,
  `oauth-integrations` (`/integrations/:provider/callback`, keyed by OAuth `state` rather than a URL param),
  and `webhooks` (`/webhooks/*`, unauthenticated, signature-verified) are registered separately, not under
  `/guilds`.
- `src/routes/discord.ts` — `GET /guilds/:guildId/discord/channels|roles`, read-only lists backing the dashboard's
  channel/role pickers. Not in ARCHITECTURE.md §10's original list; fetched with the **bot** token (the user's OAuth
  scopes cannot read guild channels/roles), cached 60s per guild in Redis, and answering 503 `bot_token_missing`
  when the API process has no `DISCORD_TOKEN` (the dashboard then falls back to raw id inputs).
- `src/openapi-export.ts` — builds the app against fakes and writes `docs/openapi.json`.

## Session & security model

- **Session**: `sid` cookie (httpOnly, `SameSite=Lax`, `Secure` in production, signed with `SESSION_SECRET`),
  backed by a Redis-stored `SessionData` row (`src/lib/session.ts`) with encrypted (`ENCRYPTION_KEY`) Discord
  access/refresh tokens, a 7-day TTL that slides forward on every read, and a random `csrfToken`.
- **CSRF**: every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) outside a small exemption list
  (`/webhooks/*`, `/auth/test-login`) must carry `X-CSRF-Token` matching the session's token, and — when
  present — an `Origin`/`Referer` in the `DASHBOARD_URL` allowlist.
- **Guild access**: `requireGuildAccess()` re-derives the actor's Discord guild list (cached 60s in Redis)
  and requires `MANAGE_GUILD`/`ADMINISTRATOR`/ownership on `params.guildId`, then requires the bot to be
  present in that guild (404 otherwise) unless the route opts out.
- **Webhooks**: raw-body signature verification (GitHub `X-Hub-Signature-256`, Stripe `Stripe-Signature`,
  Twitch EventSub HMAC + `webhook_callback_verification` challenge echo, and a generic
  `X-Pavisie-Signature` HMAC for per-guild endpoints), idempotent via `ProcessedWebhookEvent`
  (`@@unique([provider, eventId])`), 5MB body limit, then enqueued onto the `integrations.inbound` BullMQ
  queue for the bot host to process.
- **Errors**: `setErrorHandler` never leaks stack traces or raw internal error messages — only `AppError`s
  with `expose: true` (client-facing 4xx) surface their real message; everything else becomes a generic
  `internal_error` / 500. Zod validation failures (both raw `ZodError`s and `fastify-type-provider-zod`'s
  wrapped `FST_ERR_VALIDATION`) become a consistent `{ error: { code: 'validation_error', details: { issues } } }`
  400 response.

## Known gaps / not built here

- `docs/ADDENDUM-2026-08-16.md` §18 (`routes/donations.ts`, Stripe donation checkout) and §19's API section
  (`routes/enforcer.ts`) are **not** implemented — the `Donation` and `Enforcer*` Prisma models referenced by
  that addendum don't exist yet in `packages/database/prisma/schema.prisma`, and this task's route list
  (ARCHITECTURE.md §10 as assigned) doesn't include them. Flagged for whoever picks up that addendum.
- The `ai` plugin's `configSchema` is still a `z.object({}).passthrough()` stub (see
  `packages/plugins/src/ai/manifest.ts`); `routes/ai.ts` stores `provider`/`apiKeyEnc` as passthrough fields
  today and will keep working once the real schema lands, but the dashboard-facing shape of "settings" may
  need a follow-up pass then.
- `routes/logging.ts`'s log search filters on `payload->>'title'`/`payload->>'description'` via `$queryRaw`
  (parameterized, never string-concatenated) — this is exactly what ARCHITECTURE.md §10 specifies, but it
  does mean log search only matches those two payload fields, not arbitrary payload content.
