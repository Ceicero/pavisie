# Logging plugin

Routes member, message, role, channel/thread, server-setting, moderation, voice, invite-use, and platform
(bot error / webhook failure / automod / ticket / verification) events to per-kind configured log channels, with
redaction, retention, and a searchable dashboard audit log. Default enabled (Discord id: `logging`).

## Commands

All under `/logs` (`ModerateMembers` required by default to see the command; `set`/`disable`/`retention`/`redact`
require `admin` staff level, checked internally):

| Command                                   | Staff level | What it does                                                                                       |
| ----------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `/logs set <kind> <channel>`              | admin       | Routes a kind (or `default`) to a channel; also re-enables that kind if it was disabled            |
| `/logs disable <kind>`                    | admin       | Stops logging a kind; keeps its channel mapping for later                                          |
| `/logs status`                            | moderator   | Shows the kind → channel table, storage/retention/redaction settings, and privileged-intent status |
| `/logs retention <days>`                  | admin       | Sets this plugin's own `LogEvent` retention window                                                 |
| `/logs redact add\|remove\|list <regex>`  | admin       | Manages custom redaction patterns (validated with `validateUserRegex`)                             |
| `/logs test <kind>`                       | moderator   | Sends a sample entry through the real log/redact/store pipeline                                    |
| `/logs search user:<user> [kind] [since]` | moderator   | Ephemeral, paginated search of stored `LogEvent` rows                                              |

## Config keys (`configSchema`, all defaulted)

- `channels: Record<LogKind | 'default', string | null>` — per-kind channel routing, default `{}`
- `enabledKinds: LogKind[]` — which kinds actually generate log entries, default: all kinds
- `storeEvents: boolean` — persist `LogEvent` rows for search/export, default `true`
- `retentionDays: number` (1–3650) — this plugin's own retention window, default `90`
- `redactionPatterns: string[]` (max 20) — custom regex patterns applied on top of the built-in ones
- `captureContent: boolean` — effective only together with `GuildConfig.logMessageContent` (core, guild-wide)

## Permissions (why, and fallback if missing)

| Permission                  | Feature                               | Optional | Fallback                                                      |
| --------------------------- | ------------------------------------- | -------- | ------------------------------------------------------------- |
| View Channel, Send Messages | Posting log embeds                    | No       | That channel's logs are skipped and an error is logged        |
| Embed Links                 | Rich log embeds                       | No       | Discord blocks the send entirely; the embed is dropped        |
| Read Message History        | Live edit/delete diffing              | Yes      | Falls back to cached data only                                |
| Manage Guild                | Invite-use attribution (`invite.use`) | Yes      | Member joins still logged, just without which invite was used |

## Privileged intents

- **Guild Members** — join/leave/nickname/role/timeout events. Without it, the plugin still works for every
  other event kind; member-related kinds simply never fire.
- **Message Content** — actual edit/delete text. Without it, edit/delete logs still fire (metadata: actor,
  channel, message id, jump link) with a "content not captured" note instead of text.

Missing either intent makes the plugin **degraded**, not unavailable (`PluginRegistry.availability`).

## Privacy notes

- No message content is captured by default. It only appears when **both** this plugin's `captureContent` and
  the server-wide `GuildConfig.logMessageContent` are on.
- Every stored/displayed payload is redacted first: emails, phone numbers, Discord-token-shaped strings,
  credit-card-shaped digit runs, and IPv4 addresses are replaced with `[redacted:<name>]` placeholders by
  default, plus any admin-configured custom regex patterns.
- `LogEvent` rows are purged daily by the `logging:retention` job, at
  `min(config.retentionDays, DataRetentionPolicy.logEventDays)`. Turning off "Store events" stops persistence
  entirely — log channels still receive live embeds either way.
- Log messages are always sent with `allowedMentions: { parse: [] }`, and embeds (unlike message `content`)
  never trigger pings from Discord regardless, so raw `@everyone`/user-mention text landing in a log payload is
  inert.

## Dashboard page

`/dashboard/[guildId]/logging` — three tabs: **Channels** (per-kind channel picker + enable toggle, a default
fallback channel, storage/content-capture switches with a link to the server-wide content setting, and
retention), **Redaction** (custom pattern list + a live test box backed by `POST .../redaction/test`), and
**Search** (filters, a results table with a JSON detail dialog, cursor pagination, and CSV export).

## Cross-plugin service (`ServiceMap['logging']`)

```ts
interface LoggingService {
  log(guildId: string, kind: LogKind, payload: LogPayload): Promise<void>;
}
```

Any other plugin can call `ctx.services.get('logging')?.log(...)` and no-op gracefully if logging is disabled or
unavailable. This plugin also mirrors a handful of in-process platform events (`plugin.error`,
`webhook.deliveryFailed`, `moderation.caseCreated` (deduped by `caseId` in Redis for 60s),
`automod.triggered`, `ticket.opened`/`ticket.closed`, `member.verified`) into the same pipeline — see
`platform-events.ts`.

## Known design decisions / open questions

- `LogKind` (ARCHITECTURE.md §7.5) has fewer members than the raw Discord events this plugin listens to.
  `roleCreate`/`roleUpdate`/`roleDelete` **and** member role-assignment/nickname changes all route to
  `'role.update'`; `channelCreate`/`channelUpdate`/`channelDelete`/`threadCreate`/`threadDelete` all route to
  `'channel.update'`; member timeout changes route to `'moderation.action'`. This mirrors SPEC.md §D's single
  "Role changes" / "Channel and server setting changes" bullets, which don't distinguish create/update/delete
  either — but it is an interpretation, not something spelled out verbatim anywhere. Each handler still sets a
  specific `payload.title` (e.g. "Role deleted") so the distinction survives in the embed/stored payload even
  though the `kind` column (and `enabledKinds` toggle) groups them.
- `LogKind`/`LOG_KIND_LABELS` are duplicated in `@pavisie/types`'s `src/logging.ts` for the dashboard/API (which
  never import `@pavisie/plugins`'s runtime code). A follow-up wiring pass could move the union into
  `@pavisie/types` and have `sdk/services.ts` re-export it, eliminating the duplication — out of this task's
  ownership (`sdk/**` and `packages/types/src/index.ts` are both off-limits here).
