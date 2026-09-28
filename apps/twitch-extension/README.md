# @pavisie/twitch-extension — Agis panel

A Twitch panel extension shown under a streamer's video, backed by the API's `/twitch-ext/*` routes
(`apps/api/src/routes/twitch-ext.ts`, ARCHITECTURE.md §19d). Shows the guild's currency name/symbol, the
viewer's Twitch-wallet balance, a "Claim daily" button, and the Twitch leaderboard.

Plain HTML/CSS + TypeScript compiled straight to browser-native ES modules — **no framework, no bundler**. The
only remote script is Twitch's own extension helper (`extension-files.twitch.tv/helper/v1/twitch-ext.min.js`),
which Twitch requires. No inline scripts, no `eval`, no remote fonts/CDNs — Twitch's extension review rejects
all three.

## Layout

- `public/panel.html`, `public/panel.css` — the panel itself (318px wide, Twitch's panel width constraint).
- `public/config.html` — the broadcaster-facing config page. It has nothing to configure (setup happens in the
  Pavisie dashboard), so it just says that and links nowhere external.
- `src/panel.ts` — panel logic. Pure helpers (`formatCountdown`, `formatAmount`, `msUntil`) are exported and
  unit-tested in `src/panel.test.ts`; everything DOM/`Twitch.ext`-facing is guarded behind
  `typeof window !== 'undefined'` so importing the module under `vitest` (Node) never touches the DOM.
- `scripts/build.mjs` — compiles `src/*.ts` to `dist/*.js` (via `tsconfig.build.json`) and copies `public/*`
  into `dist/`, flat. `dist/` is exactly what you zip and upload.

## Build

```
pnpm --filter @pavisie/twitch-extension build
```

Produces `dist/panel.html`, `dist/panel.js`, `dist/panel.css`, `dist/config.html`. Zip the *contents* of
`dist/` (not the `dist/` folder itself) for the Twitch dev console upload.

## API base URL

`src/panel.ts`'s `DEFAULT_API_BASE_URL` (`https://api.pavisie.com`) is a compile-time constant — there is no
runtime/inline config object, since Twitch's review disallows inline scripts. Pointing the panel at a different
API means editing that constant and rebuilding.

## Twitch dev console setup

1. **console.twitch.tv** → your Extension → **Asset Hosting** (or "Files" depending on the console version) →
   upload the zipped `dist/` contents as a new version.
2. **Capabilities**:
   - **Panel** component: viewer path `panel.html`, height as Twitch's panel default.
   - **Configuration** page: `config.html`.
   - **Request Identity Link**: **On** (the panel's balance/daily claim needs the viewer's real Twitch user id;
     without this every viewer is permanently in the "share your identity" state).
   - **Allowlist for URL Fetching Domains**: add the API origin the build points at (`api.pavisie.com` by
     default, or whatever `DEFAULT_API_BASE_URL` was rebuilt with) — Twitch blocks `fetch`/`XHR` to any origin
     not on this list.
3. **Extension Secrets**: console.twitch.tv → your Extension → **Extension Secrets** → generate one, then set
   it as `TWITCH_EXTENSION_SECRET` on the API's Railway environment (and the Extension's **Client ID**, shown
   on the Extension's **Settings** tab, as `TWITCH_EXTENSION_CLIENT_ID`). See `.env.example` and
   `infra/DEPLOYMENT.md` §6.
4. **Hosted Test**: the dev console's "Hosted Test" view runs the just-uploaded version end-to-end against a
   real (or your own test) channel before it goes to review — use this to confirm the panel loads, the
   identity-share prompt works, and a daily claim round-trips against the real API.
5. **Submit for review**: once Hosted Test looks right, submit the version for Twitch's review from the same
   console. Review turnaround and requirements are Twitch's own process — nothing in this repo automates it.

## Tests

```
pnpm --filter @pavisie/twitch-extension test
```

Covers the pure formatting/date-math helpers only (`formatCountdown`, `formatAmount`, `msUntil`) — there is no
DOM/Twitch-helper integration test here, matching how `apps/api`'s own tests exercise the EBS routes instead.
