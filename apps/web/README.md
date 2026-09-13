# @pavisie/web

The public Pavisie marketing website **and, since the dashboard→web merge, the per-guild config
dashboard** (`/dashboard/**` — formerly its own app, `@pavisie/dashboard`; that app is now a
legacy-link redirector, see `apps/dashboard/README.md`). Next.js 15 App Router, Tailwind 3. Marketing
pages use a black/grey/white "smoky UI" theme with a gold brand accent; dashboard pages use `@pavisie/ui`'s
shadcn-style tokens. See `docs/ARCHITECTURE.md` §17 (site) and §11 (dashboard) for the full design,
and `docs/SPEC.md` §M for requirements.

Marketing pages depend only on `@pavisie/types` and the site's own small black/grey/white-plus-gold component set
under `src/components/` (not `@pavisie/ui`, not `@pavisie/core`) — they call the public API
directly over `fetch`. The dashboard routes under `src/app/dashboard/**` (and their components/lib
under `src/components/dashboard/**`, `src/lib/dashboard/**`) additionally depend on `@pavisie/ui`,
`@tanstack/react-query`, and `next-themes`; both component systems coexist via one Tailwind config
(`tailwind.config.ts`'s `presets: [preset]` plus the site's own `ink`/`grey`/`paper` tokens). One
top bar (`src/components/TopBar.tsx`) and one root `Providers` (`src/components/Providers.tsx`,
mounted for the whole app) serve both halves — see their doc comments for how each adapts by route.

## Pages

| Route                                 | What it is                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                   | Hero, "Add to Discord" / "Open dashboard" CTAs, feature overview grid, why-gaming-communities, Enforcer teaser, trust & compliance, donate CTA |
| `/features`                           | Every plugin: headline, why gaming communities love it, full command table — all anchored on one page                                          |
| `/features/[pluginId]`                | Same content, one plugin per page (statically generated from `src/data/commands.json`)                                                         |
| `/enforcer`                           | Admin Enforcer spotlight: workflow diagram, a mock ledger entry, privacy/transparency notes, FAQ                                               |
| `/donate`                             | Ko-fi link-out: external donation page when enabled, "not set up" notice when disabled                                                         |
| `/privacy`, `/terms`                  | Template legal pages, clearly labelled as templates for the operator to review                                                                 |
| `/dashboard/**`                       | The per-guild config dashboard (session-gated) — see `docs/ARCHITECTURE.md` §11 for the full route list          |
| `not-found`                           | 404 page                                                                                                                                       |

Command documentation is **generated, never hand-maintained** — see "Data" below.

## Local development

```
pnpm --filter @pavisie/web dev
```

Runs on <http://localhost:3003>. `predev`/`prebuild` run `scripts/sync-brand.mjs` first, which copies the brand
logo from `assets/brand/` into `public/brand/`, `src/data/brand.json`, and `src/app/apple-icon.<ext>` (a no-op —
never fails the build — if the source asset is missing; every consumer degrades to a text wordmark or plain
Open Graph text instead).

For the donate page to show the Ko-fi link-out, run `@pavisie/api` locally (`pnpm --filter @pavisie/api dev`)
with `KOFI_URL` set — otherwise `/donate` correctly shows the "not configured" state.

## Environment

See the root `.env.example` for the full list. This app reads, all via `NEXT_PUBLIC_*` (inlined at build time into
both server and client bundles):

- `NEXT_PUBLIC_API_URL` — base URL of `@pavisie/api`, used for `GET /donations/config` and by every
  dashboard page's `apiFetch`/React Query hooks.
- `NEXT_PUBLIC_DISCORD_CLIENT_ID` — builds the "Add to Discord" OAuth URL. When unset, the CTA falls back to
  "Explore features" instead of linking to a broken authorize URL.
- `NEXT_PUBLIC_INVITE_PERMISSIONS` — invite permission bitfield (integer string). Defaults to the value baked
  into `src/data/invite.json` (kept in sync with `INVITE_PERMISSIONS` in `@pavisie/core` by `pnpm commands:export`).
- `NEXT_PUBLIC_SUPPORT_SERVER_URL` — optional; shows a "Support server" link in the footer and the dashboard
  sidebar/error states.

The "Open dashboard" CTA is a plain same-origin `/dashboard` link now (the dashboard UI is part of
this app) — there's no `NEXT_PUBLIC_DASHBOARD_URL` anymore.

`COOKIE_DOMAIN` (server-side, not `NEXT_PUBLIC_*`) is read by `src/middleware.ts`: when set, it
fast-redirects a cookie-less `/dashboard/*` visit to `/` at the edge, before any client JS runs.
Leave it unset locally — see that file's doc comment for the full reasoning.

## Data

`src/data/commands.json` and `src/data/invite.json` are generated (never hand-edited) by `pnpm commands:export`
(`packages/plugins/scripts/export-commands.ts`), which also writes `docs/commands.json` and `docs/invite.json`.
CI regenerates them and fails the build if they're stale (`git diff --exit-code`) — so the command tables on
`/features` can never drift from what the bot actually registers.

`src/content/*.ts` (`plugins.ts`, `site.ts`, `enforcer.ts`, `legal.ts`) is the only hand-written copy on the
site — headlines, "why gaming communities love it" bullets, the Enforcer FAQ, and the privacy/terms templates.

## Design system

- **Palette**: CSS variables in `src/app/globals.css` (`--ink-0`…`--ink-7`, `--grey-1`…`--grey-7`, `--paper`,
  `--gold-1`…`--gold-7`). Black/grey/white plus one gold accent ramp — no other colour accents. Verify with
  `grep -rniE "#[0-9a-f]{3,8}\b" src --include=*.tsx --include=*.ts` (should only turn up the token
  definitions, the hardcoded hex the `opengraph-image.tsx` satori renderer needs (it can't read CSS
  variables), and monochrome SVG strokes referencing `var(--grey-*)`) and by checking no `text-red-*` /
  `bg-blue-*` / etc. Tailwind default-palette classes are used anywhere in `src/`. Applying `gold-*` classes
  to a component is a separate design decision — defining the tokens doesn't imply every page uses them.
- **Smoky UI**: `Smoke.tsx` (drifting blurred blobs), `Grain.tsx` (SVG noise overlay), `.glass` utility class
  (frosted-glass cards). All pure CSS; the global `prefers-reduced-motion` rule in `globals.css` disables the
  drift animation.
- **Fonts**: system stack only (`ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, sans-serif`) — no
  network font loading, so the build works fully offline.
- **Accessibility**: semantic landmarks (`header`/`main`/`footer`/`nav`), a skip-to-content link, visible focus
  rings on every interactive element, and AA contrast within the gold-and-black palette (docs/ARCHITECTURE.md
  §20 has the verified figures for the two gold accent roles).

## Testing & build

```
pnpm --filter @pavisie/web typecheck
pnpm --filter @pavisie/web lint
pnpm --filter @pavisie/web test    # includes the moved dashboard-nav/brand-wordmark/middleware suites
pnpm --filter @pavisie/web build   # standalone output is auto-skipped on win32; see next.config.ts
pnpm --filter @pavisie/web test:e2e
```

`e2e/` has the marketing smoke specs (`home.spec.ts`, no API/auth needed) plus, since the merge,
`dashboard-login.spec.ts` and `dashboard-config.spec.ts` (moved from the old `apps/dashboard/e2e/`
unchanged) — those two self-skip unless `E2E_API_URL` points at a running API with
`E2E_TEST_MODE=true`, same as before.
