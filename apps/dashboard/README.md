# @pavisie/dashboard

`app.pavisie.com`. **This is not the per-guild config dashboard anymore** — that moved into
`apps/web` at `pavisie.com/dashboard/**` (see `apps/web/README.md` and
`docs/ARCHITECTURE.md` §11). This service's job today is narrower:

1. **Redirect old links.** Every `app.pavisie.com/` and `app.pavisie.com/dashboard/...`
   request 308s to the equivalent `WEB_URL` path (`next.config.ts`'s `redirects()`), so bookmarks,
   the Top.gg listing, and a live Reddit post pointing at the old domain never 404. The redirect is
   **path-scoped, not a blanket catch-all** — see the next point.
2. **Host Brandon's upcoming owner-only ops console.** Cross-server support tickets, fleet metrics,
   error monitoring, bot health — planned for this same service, most likely on a separate
   `dev.pavisie.com` domain. That's why the redirect above only covers `/` and `/dashboard/*`:
   a wildcard redirect would fight future `/ops/...` routes.

## What's still real here (not stripped out)

This is a fully working, deployable Next.js app, not a bare config file — kept that way
deliberately so the ops console above has a real foundation to build on:

- `src/app/layout.tsx` + `src/components/providers.tsx` — theme (`next-themes`, class-based dark
  mode) + React Query + a `Toaster`, same pattern the dashboard used before the merge.
- `src/lib/api.ts` / `src/lib/session.tsx` — the same `apiFetch`/`SessionProvider`/`useSession()`
  pair the config dashboard uses in `apps/web`, so an auth-gated ops page can be added the same way.
- `@pavisie/ui` + Tailwind wiring (`tailwind.config.ts`, `postcss.config.mjs`) — the shared
  component library still works here.
- `src/app/page.tsx` — an honest placeholder ("nothing here yet") that exercises the session/theme/
  UI wiring above, so it's a verified baseline rather than dead scaffolding. It is **not** reachable
  at `app.pavisie.com/` in production (the redirect above sends `/` to the website first) —
  it's what you see running this app directly (e.g. locally, or before `WEB_URL`/DNS are wired up).

Not carried over: the per-guild config pages, components, and React Query hooks
(`moderation`/`automod`/`tickets`/etc.) — those are guild-config-specific, not ops-console-shaped,
and now live in `apps/web/src/app/dashboard/**` and `apps/web/src/{components,lib}/dashboard/**`.
Pull specific pieces back here if the ops console ends up needing them (`src/lib/format.ts`'s date
helpers are a likely candidate — generic and cheap to restore).

## Running locally

```bash
pnpm --filter @pavisie/dashboard dev     # http://localhost:3000
```

Visiting `/` or `/dashboard/*` locally redirects to `WEB_URL` (defaults to
`http://localhost:3003`, the web app's dev server — not the production domain, so this never
bounces a local run out to the real site). Any other path (once the ops console has routes) falls
through to this app normally.

Environment variables (see root `.env.example`):

- `NEXT_PUBLIC_API_URL` — base URL of the API, kept wired for the session/theme scaffolding above.
- `WEB_URL` — redirect target for the legacy `/` and `/dashboard/*` paths (server-side; read at
  request time by `next.config.ts`, not a build-time `NEXT_PUBLIC_*` var).

## Testing

- `pnpm --filter @pavisie/dashboard typecheck`
- `pnpm --filter @pavisie/dashboard lint`
- `pnpm --filter @pavisie/dashboard test` — `test/next-config.test.ts` (the redirect rules) and
  `test/brand-wordmark.test.ts` (the restored brand mark).
- `pnpm --filter @pavisie/dashboard build`

`e2e/` has no specs right now (the old `login.spec.ts`/`config.spec.ts` moved to `apps/web/e2e/`
along with the pages they tested) — `playwright.config.ts` is kept in place for whenever the ops
console has real flows to cover.
