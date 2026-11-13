# Pavisie Dev (desktop app)

An owner-only desktop app that tracks stats for the whole Pavisie project: Discord servers and usage, Twitch
channels and usage, every integration connection, and recent errors. It only reads numbers — it cannot change
anything on the server.

It is a standalone Electron app. It is deliberately **not** part of the pnpm workspace (it has its own
`package.json` and `package-lock.json`), so the bot, API and website builds never download Electron.

## What it shows

| Screen       | What is on it                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| Overview     | Headline counts for both platforms, messages per day, server growth, new Twitch channels, and what needs attention |
| Discord      | Servers joined and left, members reached, daily usage (messages, moderation, automod, tickets), every server       |
| Twitch       | Linked channels by connection state, stream-live alerts, commands/timers/rewards, channel currency, every channel  |
| Integrations | Every server integration by service and connection state                                                           |
| Health       | Open developer reports, waiting Enforcer flags, and the recent error feed                                          |

The time range (7, 30 or 90 days), a refresh-every-minute switch, and an **Export** button (saves the current
numbers as a JSON file) sit at the top of every screen.

## Get the app

Download the installer for your computer from the repository's **Actions** tab → **Desktop app** → the latest
run → **Artifacts**, or build it yourself:

```bash
cd desktop
```

```bash
npm ci
```

```bash
npm run dist
```

The installer lands in `desktop/dist/`. `npm run dist` builds for the computer you run it on; `dist:win`,
`dist:mac` and `dist:linux` pick one explicitly (a macOS build needs a Mac).

The builds are not code-signed, so the first launch shows a warning: on Windows choose **More info → Run
anyway**; on macOS right-click the app and choose **Open**.

## First run

1. Leave **Pavisie API address** as `https://api.pavisie.com`, or type your own API's address.
2. Click **Sign in with Discord** and sign in with the account that owns the bot. The app opens Discord's own
   sign-in page; it never sees your password.
3. That Discord account's user ID must be listed in `BOT_OWNER_IDS` on the API. If it is not, the app says so.

**Preview with sample data** on the sign-in screen shows every screen with made-up numbers, clearly labelled,
without signing in.

The Twitch and Integrations screens need an API that includes `GET /owner/metrics/twitch`,
`/owner/metrics/twitch/channels` and `/owner/metrics/integrations`. Against an older API those two screens say
the API needs updating and the rest of the app keeps working.

## How it stays safe

- **Read-only.** The window can only ask the main process for a fixed list of `GET` paths
  (`src/lib/api-client.cjs`). There is no code path that writes to the API.
- **Same owner gate as the web.** Every number comes from `/owner/metrics/*`, which the API only serves to a
  signed-in Discord user listed in `BOT_OWNER_IDS`.
- **No secrets on disk.** `settings.json` in the app's data folder holds the API address and display
  preferences. The login is a session cookie kept in the app's own browser profile; **Sign out** deletes it.
- **Locked-down window.** Context isolation and the sandbox are on, Node is off in the window, a strict
  Content-Security-Policy is set, navigation away from the app is blocked, and every permission request is
  denied. Server and channel names are always inserted as text, never as HTML.
- **https only.** The API address must be `https://` (plain `http://` is accepted for `localhost` only).

## Develop

```bash
npm start
```

```bash
npm test
```

`npm start` runs the app from source. `npm test` runs the unit tests (number formatting, the request allowlist,
error messages, settings). Layout:

```
desktop/
├── src/main.cjs            main process: windows, Discord sign-in, IPC
├── src/preload.cjs         the few functions the window is given
├── src/lib/                API client (allowlist), API address validation, settings file
├── src/renderer/           the window: screens (app.js), charts, formatting, styles, sample data
├── build/                  app icons (generated from assets/brand/pavisie-skull.png)
└── test/                   node --test unit tests
```
