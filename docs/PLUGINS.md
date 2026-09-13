# Plugin configuration guide

Pavisie is modular: every feature area is a self-contained plugin (`packages/plugins/src/<id>`)
that a server administrator turns on or off per Discord server (guild), independently of every
other server the bot is in. This guide is the map — how enable/disable works, how per-guild config
works, the full plugin table, and a click-path walkthrough for the one plugin (`enforcer`) with a
multi-step setup flow. For the deep-dive on any one plugin (exact config keys, permissions,
privacy notes, and design tradeoffs) follow the README link in the table to
`packages/plugins/src/<id>/README.md` — this page stays intentionally short per plugin.

## 1. Enable/disable

Two equivalent ways to turn a plugin on or off for one server — both write to the same
`PluginState` row, so they always agree:

- **Dashboard** — `/dashboard/[guildId]/plugins` (the "Settings" → "Plugins" page, or the
  marketplace grid linked from the guild overview). Every plugin is a card with an enable/disable
  switch, an availability badge (see below), and a "Configure" action that opens the config
  drawer.
- **Discord** — `/plugin enable <plugin>` / `/plugin disable <plugin>` (admin staff level only;
  part of the always-on `admin` plugin, `packages/plugins/src/admin`). `/plugin status [plugin]`
  shows enabled/available/degraded state, missing bot permissions, and privileged-intent status
  for one plugin or all of them. `/plugin list` shows every plugin grouped by category with an
  enabled/disabled marker.

Toggling calls the plugin's `onGuildEnable`/`onGuildDisable` hook (if it has one) and is written to
the audit log with the actor, timestamp, and source (`bot` or `dashboard`) — visible on
`/dashboard/[guildId]/audit`. One plugin, `admin`, is `alwaysEnabled: true` and cannot be disabled —
it's what lets staff manage every other plugin, including itself.

**Availability vs. enabled** are different things. A plugin can be _enabled_ for a guild but still
show as **unavailable** if something the platform operator controls is missing — most commonly a
`requiredEnv` variable that isn't set (e.g. the `media` plugin needs `MEDIA_PROVIDER` set to
something other than `none`) or a privileged Discord intent the bot doesn't have turned on (e.g.
`automod`/`enforcer` degrade without the **Message Content** intent, and `community`'s tag
auto-responders go inactive while `/tag show` keeps working). `/plugin status` and the
dashboard's availability badge both explain exactly why, so it's never a silent no-op.

## 2. Per-plugin configuration (the config drawer)

Every plugin defines its own guild-scoped config as a Zod schema (`configSchema` in its
`manifest.ts`) with a default for every field. The dashboard never needs a hand-built settings form
for a plugin that doesn't have one: `/dashboard/[guildId]/plugins` reads each plugin's schema
(exposed by the API as JSON Schema) and renders a form automatically in the **config drawer** —
open a plugin's card and click "Configure." A handful of plugins with enough surface area to
deserve a full page (see the "Dashboard page" column below) additionally get one, but the config
drawer works for every plugin, including the ones without a dedicated page (`economy`, `utility`).

From Discord, `/config view` (paginated, ephemeral) shows core `GuildConfig` plus every enabled
plugin's config keys; `/config set <key> <value>` sets one (`guild.<field>` for core config,
`<pluginId>.<field>` for a plugin's own field, with autocomplete and type-aware parsing — booleans,
numbers, channel/role mentions or raw ids, comma-separated lists, `none` to clear a nullable
field); `/config reset <key>` puts a key back to its manifest default. Both the dashboard drawer and
`/config set` write through the same `GuildConfigStore` (Redis-cached, 300s TTL, invalidated on
write), so a change from either surface is visible everywhere within moments.

## 3. Plugin table

| id             | Default                       | Privileged intents                           | Key config fields                                                                                                                                                                                                                      | Dashboard page                         | README                                                                                          |
| -------------- | ----------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `admin`        | Always on                     | —                                            | `fastActions`, `setupCompleted`, `staffChannelId` (mirrors of core `GuildConfig`)                                                                                                                                                      | `/dashboard/[guildId]/settings`        | [`packages/plugins/src/admin/README.md`](../packages/plugins/src/admin/README.md)               |
| `moderation`   | On                            | —                                            | Escalation rules, DM-on-action, case number sequence (per guild)                                                                                                                                                                       | `/dashboard/[guildId]/moderation`      | [`packages/plugins/src/moderation/README.md`](../packages/plugins/src/moderation/README.md)     |
| `automod`      | On (dry-run)                  | Message Content, Server Members              | Rules (keyword/regex/link/mention-spam/etc.), dry-run toggle, exemptions                                                                                                                                                               | `/dashboard/[guildId]/automod`         | [`packages/plugins/src/automod/README.md`](../packages/plugins/src/automod/README.md)           |
| `enforcer`     | Off                           | Message Content (auto-flag only)             | `ledgerChannelId`, `flagChannelId`, `muteRoleId`, `captureContext`, `autoFlagEnabled`, `allowedDecisions`                                                                                                                              | `/dashboard/[guildId]/enforcer`        | [`packages/plugins/src/enforcer/README.md`](../packages/plugins/src/enforcer/README.md)         |
| `logging`      | On (no-op until channels set) | Server Members, Message Content              | Per-kind log channels, retention, content-capture toggle, redaction rules                                                                                                                                                              | `/dashboard/[guildId]/logging`         | [`packages/plugins/src/logging/README.md`](../packages/plugins/src/logging/README.md)           |
| `tickets`      | Off                           | Message Content (transcripts)                | Panels, categories, transcript retention, staff/tag config                                                                                                                                                                             | `/dashboard/[guildId]/tickets`         | [`packages/plugins/src/tickets/README.md`](../packages/plugins/src/tickets/README.md)           |
| `roles`        | Off                           | Server Members                               | Role panels, groups, role persistence, auto-roles, welcome/goodbye embeds, verification, onboarding checklist                                                                                                                          | `/dashboard/[guildId]/roles`           | [`packages/plugins/src/roles/README.md`](../packages/plugins/src/roles/README.md)               |
| `engagement`   | On                            | Message Content                              | Leveling curve/rewards, reputation, starboard, temp-voice                                                                                                                                                                              | `/dashboard/[guildId]/engagement`      | [`packages/plugins/src/engagement/README.md`](../packages/plugins/src/engagement/README.md)     |
| `community`    | On                            | Message Content (auto-responders only)       | Poll/giveaway/suggestion/announcement/reminder/event defaults; tags / auto-responders (`tags.*`); sticky messages (`sticky.*`); auto-publish, auto-threads; server-stats counter channels (`statsChannels`); birthdays (`birthdays.*`) | `/dashboard/[guildId]/community`       | [`packages/plugins/src/community/README.md`](../packages/plugins/src/community/README.md)       |
| `gamestats`    | Off (needs `STEAM_API_KEY`)   | —                                             | None yet — linking is entirely member-self-service via `/dbd link`/`/dbd unlink`, nothing to configure per guild                                                                                                                       | Config drawer only (no dedicated page) | [`packages/plugins/src/gamestats/README.md`](../packages/plugins/src/gamestats/README.md)       |
| `economy`      | Off                           | —                                            | Currency name/symbol, daily reward range + streak bonus, give limits — virtual only, no real money                                                                                                                                     | Config drawer only (no dedicated page) | [`packages/plugins/src/economy/README.md`](../packages/plugins/src/economy/README.md)           |
| `utility`      | On                            | —                                            | Timezone defaults, translate/weather provider selection                                                                                                                                                                                | Config drawer only (no dedicated page) | [`packages/plugins/src/utility/README.md`](../packages/plugins/src/utility/README.md)           |
| `media`        | Off (needs `MEDIA_PROVIDER`)  | —                                            | Queue-only; unavailable unless the operator configures a compliant provider (see ROADMAP — no playback shipped yet)                                                                                                                    | —                                      | [`packages/plugins/src/media/README.md`](../packages/plugins/src/media/README.md)               |
| `integrations` | Off                           | —                                            | Connections (OAuth), alert routes, inbound/outbound webhook endpoints                                                                                                                                                                  | `/dashboard/[guildId]/integrations`    | [`packages/plugins/src/integrations/README.md`](../packages/plugins/src/integrations/README.md) |
| `ai`           | Off                           | Message Content (`/summarize`, mention chat) | Provider/model selection, per-server API key (encrypted), channel allowlist, budget, mention chat (`chat.*`: enabled, channelIds, persona, historyMessages, maxReplyChars)                                                             | `/dashboard/[guildId]/ai`              | [`packages/plugins/src/ai/README.md`](../packages/plugins/src/ai/README.md)                     |

Three plugins (`economy`, `utility`, `gamestats`) are deliberately configured through the
auto-generated config drawer only — they don't get a dedicated dashboard route. For `economy` and
`utility` that's because their config surface is small enough that a custom page wouldn't add
anything the drawer doesn't already do; `gamestats` has no per-guild config at all in v1 (every
setting is a member's own `/dbd link`/`/dbd unlink`), so there is nothing yet for even the drawer to
show.

## 4. Enforcer setup walkthrough

`enforcer` is the one plugin with an actual guided setup, because it needs infrastructure (a
ledger channel, a flag-review channel, optionally a mute role) before it can do anything. This
walks through it end to end, in Discord first and then the dashboard equivalents.

### Prerequisites

1. The **moderation** plugin must already be enabled for the server — `/enforcer setup` refuses
   and explains why if it isn't. Enable it first: `/plugin enable moderation` (or the dashboard
   plugins page).
2. Enable `enforcer` itself: `/plugin enable enforcer` (it's off by default).
3. For _automatic_ flagging (a message gets flagged without a moderator doing anything), the bot
   needs the **Message Content** privileged intent. This is a platform-operator setting, not a
   per-guild one — see `infra/DEPLOYMENT.md` (`ENABLE_MESSAGE_CONTENT_INTENT`). Without it, manual
   flagging (the "Flag for review" message context menu and `/enforcer flag`) still works fully,
   because Discord hands the bot that message's content directly on a context-menu interaction
   regardless of the intent.

### Step 1 — Setup

Run `/enforcer setup` in the server. It's a single command with options (not a multi-step wizard
like `admin`'s `/setup wizard`) that:

- Creates or lets you pick the **ledger channel** (where every flag and decision gets posted —
  `#mod-ledger` by default) and sets its visibility (`staff`-only or `everyone`).
- Creates or lets you pick the **flag-queue channel** (where pending flags wait for a decision).
- Creates or picks a **mute role** (used by `/enforcer mute` shortcuts and `MUTE` decisions).
- Toggles **capture context** (on by default) — whether a short snapshot of the messages right
  before a flagged one is stored so a moderator has context without pinging the reporter.
- Applies the channel permission overwrites the ledger needs (`@everyone` denied send/react;
  configured staff roles allowed to view/read; the bot allowed to post). Re-running `/enforcer
setup` with `repair:true` re-applies these overwrites if they ever drift (someone manually
  changed channel permissions, a new staff role was added, etc.).

Check `/enforcer status` any time afterward — it reports setup completeness, the moderation
dependency, intent status, and current policy/pending-flag counts.

Dashboard equivalent: `/dashboard/[guildId]/enforcer` → **Settings** tab covers the same channel/
role pickers and toggles; **Overview** shows the same status summary as `/enforcer status`.

### Step 2 — Policies

A policy is what turns a raw message into an automatic flag. Two ways to get started:

- **Import a starter pack**: `/enforcer policy import` offers `invites`, `mass-mentions`,
  `scam-links`, `external-links`. None of them ship a slur list — bring your own keyword list if
  you want that kind of policy (deliberate: no baked-in wordlists to argue about or maintain).
- **Build your own**: `/enforcer policy create` takes a name, severity, and exactly one matcher
  (keyword/phrase/regex/link-domain/invite/mention-count/attachment-extension) per invocation —
  Discord's slash command options can't express a repeated group. A policy needing several
  matchers is easiest to finish from the dashboard's matcher-builder editor
  (`/dashboard/[guildId]/enforcer` → **Policies** tab → edit the policy → add matchers), which has
  no such one-per-command limit. Use `/enforcer policy test` (or the dashboard's test box) to try
  sample text against your policies before relying on them live — it reports matches without
  flagging anyone.
- `/enforcer policy list|view|edit|delete|toggle` manage what you've built. Scope any policy to
  specific channels or exempt specific roles/channels from it.

### Step 3 — Queue

Once policies are active (or you flag someone manually), pending flags land in the flag-queue
channel as an embed with decision buttons (Warn/Timeout/Mute/Kick/Ban/Dismiss — only the ones your
`allowedDecisions` config permits are shown), plus **View context** (live message context around
the flag) and **Suspect history** (that user's past flag/decision counts). Clicking a decision that
needs one opens a modal for a reason and duration; the action then runs through the same
moderation-plugin pipeline every other moderation action uses (hierarchy checks, a real
`ModerationCase`, a DM to the user with their case/record number and how to appeal). The queue
message updates in place afterward ("Decided by `<mod>` at `<time>`") instead of disappearing, so
the resolution stays visible.

Dashboard equivalent: `/dashboard/[guildId]/enforcer` → **Queue** tab lists pending flags with the
same decision dialog (reason/duration where required).

### Step 4 — Ledger

Every flag and every decision — whichever surface it came from — posts a permanent entry to the
ledger channel and to the database (`EnforcerRecord`, the source of truth; the ledger channel post
is a rendering of it, not the record itself). `/enforcer search`, `/enforcer record <number>`, and
`/enforcer history user:<user>` read it from Discord; `/enforcer export` produces a CSV.

Dashboard equivalent: `/dashboard/[guildId]/enforcer` → **Ledger** tab — searchable/filterable
table, a detail drawer per record (including the context snapshot), and CSV export.

### Step 5 — Appeals

A member who disagrees with a decision runs `/enforcer appeal record:<number>` (only works if the
record has a linked moderation case), which opens a modal and routes into the moderation plugin's
appeal workflow (`moderation.openAppeal`) — the same appeal path used for any other moderation
case, so appeals end up in one place regardless of which plugin created the underlying case.
Reviewing and deciding an appeal happens through the moderation plugin's own appeal review flow
(`/mod appeal-setup`, and the appeal review surface in `/dashboard/[guildId]/moderation`), not a
separate Enforcer-specific appeal queue.

## 5. Where to go next

- Exact per-plugin config keys, permissions, and privacy notes: the README linked in the table
  above for each plugin.
- What each plugin's Discord permissions are and how to check them against the bot's actual
  permissions in your server: `/permissions audit` (or `docs/PERMISSIONS.md`).
- What data each plugin stores and for how long: `docs/PRIVACY_POLICY_TEMPLATE.md`.
- Deploying and configuring the platform-level env vars referenced above (`MEDIA_PROVIDER`,
  the privileged-intent toggles, integration keys): `infra/DEPLOYMENT.md`.
