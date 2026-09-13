# Hub setup — declarative Discord server configuration

`scripts/hub-setup.mjs` configures a real Discord server (Pavisie's own community hub, or any
other server you point it at) from a plan JSON, instead of clicking through Discord's UI by hand.
It reconciles: roles (create/update, hierarchy order, assigning the Owner role), categories and
channels (create/update, moves into the right category, text↔announcement conversion where
possible), permission overwrites per channel, and a handful of pinned messages (rules, FAQ, AI
chat intro, booster thanks) — posted once and never reposted.

It talks to Discord over REST only (`@discordjs/rest` + `discord-api-types`) — no gateway login,
so it doesn't need the `Guilds` intent or a running bot process. It never requests the
`Administrator` permission for anything except the plan's own `Owner` role (which is meant to be
Brandon's personal admin role, not the bot's).

## Usage

```
node scripts/hub-setup.mjs --plan infra/hub/hub-plan.json --dry-run   # default — prints the plan, writes nothing
node scripts/hub-setup.mjs --plan infra/hub/hub-plan.json --apply     # actually reconciles the server
```

- `--plan <path>` is required.
- Exactly one of `--dry-run` / `--apply` may be given; if you give neither, `--dry-run` is assumed.
  Passing both is an error.
- `DISCORD_TOKEN` must be set (repo-root `.env`, or already in the environment) **even for
  `--dry-run`** — the dry run still performs every read (fetch current roles/channels/messages) so
  the printed plan reflects the server's real current state; it just skips every write. Missing
  `DISCORD_TOKEN` fails immediately with a clear message and exit code 1, before any network call.
- The bot needs Manage Roles, Manage Channels, and Manage Messages (plus the other permissions it's
  invited with — see `docs/ARCHITECTURE.md` §7.8) in the target guild. It never needs, and never
  requests, Administrator.
- **Role hierarchy matters.** The bot can only create/edit/reorder roles positioned *below* its own
  top role. If an admin hasn't dragged the bot's own role above the roles it's supposed to manage
  (in Discord's Server Settings → Roles), those roles are left untouched and reported under
  "Skipped" — nothing errors out, but nothing gets fixed either until the bot's role is moved up.
- On `--apply`, a summary of everything created/updated/skipped/posted is printed, and an id map is
  written to `infra/hub/hub-ids.json` (`{ roles: {name: id}, channels: {name: id}, categories:
  {name: id} }`, no secrets) so later steps/scripts can reference real ids instead of names.
- Safe to run repeatedly. Every step diffs against current state first and only sends a write when
  something actually differs — a second run against an already-correct server reports everything
  as "already correct" and changes nothing.
- Rate limits are handled by `@discordjs/rest` automatically. A single item failing (e.g. a 403
  because the bot is missing a permission, or a role sitting above the bot) is logged and skipped —
  it never aborts the rest of the run.

## The plan JSON

See `infra/hub/hub-plan.json` for the real one (Pavisie's hub). Top-level shape:

```jsonc
{
  "guildId": "…",                      // the Discord server this plan targets
  "ownerUserId": "…",                  // Brandon's Discord user id (gets the Owner role)
  "existing": {
    "roles": { "RoleName": "roleId" },       // roles already in the server — matched by id first
    "channels": { "someKey": "channelId" }   // channels already in the server — matched by id first
  },
  "roles_top_to_bottom": [
    {
      "name": "Owner",
      "color": "#f1c40f",              // 6-digit hex; 3-digit CSS shorthand is NOT expanded
      "hoist": true,                   // shown separately in the member list
      "mentionable": true,
      "permissions": ["Administrator"], // discord.js/discord-api-types PermissionFlagsBits names
      "assignTo": ["userId", "…"],     // optional — users who get this role assigned
      "note": "…"                      // optional, informational only, ignored by the script
    }
  ],
  "pingRoles": [ /* same shape as roles_top_to_bottom, minus assignTo/permissions in practice */ ],
  "categories_in_order": [
    {
      "name": "📌 START HERE",
      "channels": [
        {
          "name": "welcome",
          "type": "text",              // "text" | "voice" | "announcement"
          "existingKey": "…",          // optional — look up the id in existing.channels
          "existingName": "…",         // optional — look up by exact current name instead
          "topic": "…",                // optional
          "slowmode": 10,              // optional — seconds, maps to rate_limit_per_user
          "everyone": { "deny": ["SendMessages"] },     // optional
          "roleOnly": ["Helper", "Moderator"],          // optional — mutually exclusive in practice with `everyone`/`boosterOnly`
          "boosterOnly": true,                           // optional
          "botNeeds": ["ViewChannel", "SendMessages", "EmbedLinks"] // optional — extra bot-only overwrite
        }
      ]
    }
  ],
  "mutedOverwrites": { "deny": ["SendMessages", "Speak", "…"] }, // applied to the Muted role on every text/voice channel
  "messages": {
    "rules": ["line one", "line two", "…"],  // joined with "\n\n", posted once as one message in #rules (auto-split if over 2000 chars)
    "faqSticky": "…",       // posted once in #faq
    "aiChatIntro": "…",     // posted once in #ai-chat
    "boosterThanks": "…"    // posted once in #booster-lounge
  }
}
```

### Roles

- **Ordering**: `roles_top_to_bottom` then `pingRoles` (in that order) is the exact hierarchy the
  script enforces, top to bottom, positioned immediately below the bot's own role. Ping roles
  default to `hoist: false, mentionable: true` when those fields are omitted — everyone else
  defaults to `hoist: false, mentionable: false`.
- **Matching**: a role is matched by id (via `existing.roles[name]`) first, then by exact name.
  Unmatched roles are created.
- **Colors** must be 6-digit hex (`#rrggbb`); 3-digit CSS shorthand is parsed literally, not
  expanded (`#fff` → `0xfff`, not `0xffffff`) — always use 6 digits in the plan.
- **Permission names** are `PermissionFlagsBits` keys from `discord-api-types/v10`
  (`Administrator`, `ManageGuild`, `ViewChannel`, …) — the same names discord.js uses. An unknown
  name is reported as a note and ignored rather than failing the run.

### Categories & channels

- Categories are matched by exact name only (no `existingKey`/`existingName` — the plan's category
  names, with their emoji prefixes, are assumed stable once created).
- Channels are matched, in order: `existingKey` (via `existing.channels`), then `existingName`
  (exact match against any current channel), then falling back to an exact match on the channel's
  own `name` (so a channel this script created on an earlier run is found again even without an
  explicit `existingKey`/`existingName`).
- A channel is only **renamed** when the difference between its current name and the plan's `name`
  is purely cosmetic (emoji prefix, casing, whitespace — e.g. `rules` → `📖 rules`). A genuinely
  different name is left alone, with a note explaining why, rather than silently renamed.
- **Type conversion** is only ever attempted between `text` and `announcement` — the only pair
  Discord allows to convert in place, and only on Community servers. Any other type mismatch (e.g.
  a plan channel marked `voice` matching an existing `text` channel) is left as-is with a note.
  Converting text → announcement on a non-Community server fails gracefully (logged, skipped, left
  as text) rather than aborting the run.
- An empty `channels` array (e.g. the plan's `📊 SERVER STATS` category) is valid — the category is
  still created/positioned, just with nothing inside yet.

### Permission overwrites

Computed per channel from whichever of these the channel spec sets, merged (not replaced) with:

- `everyone.deny` — denies the listed permissions to `@everyone`.
- `roleOnly` — denies `@everyone` ViewChannel; allows each named role ViewChannel plus
  SendMessages (text/announcement channels) or Connect+Speak (voice channels).
- `boosterOnly` — denies `@everyone` ViewChannel; allows the guild's premium-subscriber (booster)
  role (found via `role.tags.premium_subscriber`) plus every staff role (`Helper`, `Moderator`,
  `Admin`, `Owner`). If the guild has no booster role yet, that part is skipped with a note — the
  channel still ends up staff-only until the server has its first boost.
- `botNeeds` — an overwrite for the bot's own member, granting exactly the listed permissions.
- The bot is **always** granted ViewChannel + SendMessages + EmbedLinks (in addition to anything
  else `botNeeds` asks for) in: `mod-log`, `mod-ledger`, `enforcer-queue`, `level-ups`, `welcome`,
  `stream-alerts`, `giveaways`, `faq`, `updates`, `announcements` — the channels it posts to.
- `mutedOverwrites.deny` (top-level, guild-wide) is applied to the `Muted` role on **every**
  text/voice channel, not just some.

If the same permission ends up both allowed and denied for the same role/member on the same
channel (shouldn't happen with a well-formed plan, but is handled defensively), **deny wins** —
the reconcile fails closed rather than open.

### Messages

Each of `messages.rules` / `faqSticky` / `aiChatIntro` / `boosterThanks` is posted **at most
once**, ever: before posting, the script fetches the target channel's last 20 messages and skips
if the bot has already posted there. `rules` is an array of lines joined with `"\n\n"`; the others
are single strings. Content over Discord's 2000-character limit is split into multiple messages
automatically, without breaking a line in the middle.

## Idempotency

Every step diffs against real current server state before writing anything, and only writes when
something actually differs:

- Roles/channels already matching the plan report "already correct" and are never PATCHed.
- Roles/channels not yet in Discord are created; ones that already exist (matched by id or name)
  are reused and only updated where they differ.
- A permission overwrite is (re)computed and PUT every `--apply` run (PUT is itself idempotent —
  setting the same overwrite twice is a no-op on Discord's side).
- Pinned messages are posted once and never reposted (see above).
- Role position reordering is a single bulk PATCH computed from current + desired state each run —
  re-running it when the hierarchy already matches is a no-op.

This means `--apply` can be re-run any time the plan changes (add a channel, tweak a permission,
add a role) without risking duplicate roles/channels or repeated pinned messages.

## Testing

Pure reconcile logic (plan validation, role/channel diffing, permission-overwrite computation,
role-position math, message chunking) lives in `scripts/lib/hub-setup-core.mjs` with no Discord/
network dependency, so it's unit-tested directly. Root `package.json` has no vitest config of its
own and `scripts/` isn't covered by any workspace package's test glob, so — per the same pattern
used for other root-level operator scripts — the tests live in
`apps/bot/test/hub-setup-core.test.ts` (nearest package with a working vitest+tsc setup), including
one end-to-end `--dry-run` test that runs the real `infra/hub/hub-plan.json` through
`runHubSetup()` against a fully mocked Discord REST client and asserts no mutating endpoint is ever
called:

```
cd apps/bot && pnpm test
```

`scripts/lib/hub-setup-core.d.mts` and `scripts/hub-setup.d.mts` are hand-written type
declarations for the two plain-`.mjs` modules (workspace packages export raw TypeScript with no
build step per `docs/ARCHITECTURE.md` §3, but this script stays plain ESM so it runs under plain
`node` with no loader) — update them by hand alongside the `.mjs` source if you change an exported
function's shape.
