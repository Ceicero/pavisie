# `admin` plugin

The platform's always-on control plane. Unlike every other plugin, `admin` is `alwaysEnabled: true` — it cannot be
disabled per guild, since it's what lets staff configure and manage every other plugin.

## What it does

- **`/setup wizard`** — a guided, multi-step ephemeral wizard (role selects for admin/mod/helper staff roles,
  channel selects for the mod-log and staff channels, locale/timezone selects, and a multi-select for which
  plugins to enable) that writes `GuildConfig` and plugin enablement in one pass, with a summary embed at the end.
- **`/setup status`** — shows what has been configured so far, plus a lightweight permissions warning summary.
- **`/config view`** — paginated, ephemeral view of core `GuildConfig` plus every enabled plugin's config keys.
- **`/config set <key> <value>`** — sets a single config key (`guild.<field>` for core config, `<pluginId>.<field>`
  for a plugin's own config), with autocomplete over every known key and type-aware value parsing (booleans,
  numbers, channel/role mentions or ids, comma-separated role/channel lists, "none" to clear a nullable field).
- **`/config reset <key>`** — resets a single key back to its platform/manifest default.
- **`/plugin enable|disable <plugin>`** — toggles a plugin for this guild (refuses `alwaysEnabled` plugins),
  running its `onGuildEnable`/`onGuildDisable` hook via the host.
- **`/plugin status [plugin]`** — enabled/available/degraded state, health, missing bot permissions, and
  privileged intents for one plugin or every plugin.
- **`/plugin list`** — every plugin, grouped by category, with an enabled/disabled marker.
- **`/permissions audit`** — for every _enabled_ plugin, diffs its declared bot permissions against what the bot
  actually has in this guild; also warns if the bot's highest role is at or below a configured staff role
  (hierarchy risk), and if a plugin needing a privileged intent (e.g. Message Content) is enabled without it.
- **`/health`** — gateway ping, uptime, guild count, memory, Redis ping, a `SELECT 1` database check, and each
  loaded plugin's `health()` result. Available to moderators, not just admins.
- **`/pavisie report kind:<bug|feedback|question>`** — the developer support channel: sends a message straight
  to the Pavisie developer. Two-step flow (Discord interactions can only be acknowledged once, so the privacy
  disclosure and the subject/body modal can't both ride the same interaction): the command replies ephemerally
  with a plain-language disclosure of what leaves the server plus a "Write report" button; clicking it opens a
  modal (subject + body). See "Developer reports" below for exactly what's stored/sent and the rate limits.

## Developer reports (`/pavisie report`)

- **What leaves the server**: only what the admin types into the modal (subject, body) plus unavoidable routing
  metadata — this server's id and name, the sender's user id and tag, a timestamp, and the running bot version.
  Never surrounding messages, channel history, or a member list. The disclosure embed shown before the modal
  opens says exactly this.
- **Storage**: one `DeveloperReport` row per submission (`packages/database/prisma/schema.prisma`), read by the
  owner-only API (`apps/api/src/routes/developer-reports.ts`, gated on bot-owner identity via
  `requireBotOwner`/`BOT_OWNER_IDS` — never `requireGuildAccess`, since this is intentionally cross-guild data)
  for a future ops-console UI. `status` (`OPEN`/`HANDLED`), `handledAt`/`handledBy`, and an internal `notes`
  field are owner-only triage state — never surfaced back to the reporting guild.
- **Transparency both ways**: submitting writes an entry to the reporting guild's own audit log
  (`AuditAction.DeveloperReportSubmit`), so that server's other admins can see a report was sent (not its full
  body — the audit `after` payload is just `{ kind, subject }`).
- **Rate limits** (`report-shared.ts`, via `ctx.rateLimiter`, the same Redis-backed `RateLimiterLike` every
  plugin context carries — no new infrastructure): 2 reports per admin per 30 minutes, and 5 reports per guild
  (any combination of its admins) per 60 minutes, so one noisy or malicious guild can't flood the inbox. Checked
  at modal-submission time (the only point actual inbox load happens), guild-limit first.
- **Access**: admin staff level only for now (Brandon's explicit call — start narrow, widen once real volume is
  known), same `staffLevel: 'admin'` convention as every other admin-only command here.

## Config keys

Admin's own `PluginConfig` (`admin.*`) is intentionally small:

| Key              | Type           | Default | Notes                                                                          |
| ---------------- | -------------- | ------- | ------------------------------------------------------------------------------ |
| `fastActions`    | boolean        | `false` | Mirrors `GuildConfig.fastActions` (the authoritative copy other plugins read). |
| `setupCompleted` | boolean        | `false` | Set by `/setup wizard` on completion.                                          |
| `staffChannelId` | string \| null | `null`  | Mirrors `GuildConfig.staffChannelId`.                                          |

Everything else staff actually configure day-to-day — staff role ids, locale, timezone, mod-log channel — lives
in the core `GuildConfig` table (`guild.*` keys via `/config set`), not in this plugin's own config. `admin`
reaches it (and every other plugin's enablement/config) through the `host` cross-plugin service
(`ctx.services.require('host')`) rather than the narrower per-plugin `ctx.getConfig`/`ctx.setConfig`, since those
are scoped to "this plugin's own config" by design (see `packages/plugins/src/sdk/services.ts`).

## Permissions

Every admin command replies through the interaction (ephemeral for everything except nothing — all admin
responses are ephemeral), which needs no channel-level bot permission — Discord delivers interaction responses
over the interaction token, not a regular channel send. `manifest.permissions` is intentionally empty.

## Privacy

Every configuration change — the setup wizard, `/config set`/`reset`, plugin enable/disable — is written to the
audit log with the actor, timestamp, and a redacted before/after diff (secrets/tokens/keys are never written in
plain text; see `redactForAudit` in `@pavisie/database`).

## Staff level requirements

| Command                                 | Minimum staff level |
| --------------------------------------- | ------------------- |
| `/setup wizard`, `/setup status`        | admin               |
| `/config view\|set\|reset`              | admin               |
| `/plugin enable\|disable\|status\|list` | admin               |
| `/permissions audit`                    | admin               |
| `/health`                               | moderator           |
| `/pavisie report`                      | admin               |

## Files

```
manifest.ts             PluginManifest (alwaysEnabled, defaultConfig, dashboard path)
config-keys.ts           /config set|reset key introspection + value parsing (pure, unit-tested)
format.ts                 shared embed-formatting helpers (bot permission diffing, uptime/memory formatting)
wizard.ts                 /setup wizard session store + per-step render logic + Finish persistence
report-shared.ts           /pavisie report: kind validation, length validation, rate limiting, bot version (pure, unit-tested)
index.ts                   wires manifest + commands + components, registers locales
commands/
  setup.ts                 /setup wizard|status
  config.ts                 /config view|set|reset
  plugin.ts                 /plugin enable|disable|status|list
  permissions.ts             /permissions audit
  health.ts                   /health
  report.ts                    /pavisie report kind:<bug|feedback|question> (step 1: disclosure + button)
components/
  wizard.ts                 all /setup wizard button + select-menu handlers
  report.ts                  report-continue (opens modal) + report-modal (persists + audits) handlers
locales/en.json            admin namespace strings
__tests__/config-keys.test.ts   unit tests for config-keys.ts
__tests__/report.test.ts        unit tests for /pavisie report (permission gate, rate limit, stored-field regression, audit)
```

## Notes for the bot-host implementation

`admin` depends on a `host` cross-plugin service (`ServiceMap['host']`, declared in
`packages/plugins/src/sdk/services.ts`) that the bot host process must register before `admin`'s commands are
ever routed to. It needs to expose, at minimum: `enable`/`disable`/`isPluginEnabled`, `listManifests`/`getManifest`,
`getPluginAvailability` (from `PluginRegistry.availability`), `getPluginHealth` (calls a plugin's `health(ctx)` if
defined), `getPluginConfig`/`setPluginConfig` (arbitrary plugin, via `GuildConfigStore`), `getGuildConfig`/
`updateGuildConfig` (via `GuildConfigStore`), and `getBotStats` (ws ping, uptime, guild count, memory). See the
`HostService` interface for exact shapes.

The host's per-plugin `CommandContext.t` should resolve `admin`'s keys using the same "try `admin.<key>`, then
core `<key>`" fallback that `registerPluginLocales('admin', { en })` (called once at module load in `index.ts`)
implements — see `packages/plugins/src/sdk/locales.ts`.
