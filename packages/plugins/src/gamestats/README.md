# `gamestats` — Game Stats

Per-guild leaderboards comparing members' game stats. Members opt in by pasting a Steam account (self-reported,
not verified via Steam sign-in — see "Self-reported linking" below); Pavisie fetches public stats via the Steam
Web API and renders leaderboards/stat cards. First (only) game: **Dead by Daylight** (Steam appid `381210`).
Built game-pluggable — the next game is a new descriptor under `games/`, not a new architecture. Disabled by
default.

Full contract: `docs/ARCHITECTURE.md` §19c. Requirement: `docs/SPEC.md` §P ("Steam public data only," member
opt-in + self-removal, data minimization, no console support — all implemented here, see below).

## Status: implemented

Prisma models, manifest/registration (the platform's 15th plugin), the Steam client (`steam.ts`), the
game-descriptor framework (`games/`, Dead by Daylight first), the service layer (`service.ts`), the
30-minute `gamestats-refresh` job, and the full `/dbd` command surface are all built and tested. The only
operational prerequisite is `STEAM_API_KEY` (see below).

## Self-reported linking, not verified

`/dbd link` accepts whatever SteamID64, profile URL, or vanity name a member types — there is no Steam sign-in
(OAuth or otherwise), so Pavisie has no way to confirm the account actually belongs to the person linking it.
The only enforcement against misuse is a same-guild duplicate guard: one Steam account can be linked by at most
one member per server at a time (`GameAccountLink`'s `@@unique([guildId, provider, externalId])`). Linking an
account someone else in the guild already has linked is rejected with a friendly error rather than silently
overwriting their link. This is a deliberate trade-off, not an oversight — see `docs/SPEC.md` §P and
`docs/ARCHITECTURE.md` §19c.

## Steam-only, honestly labeled

Console players cannot be supported — there is no public stats API for console platforms. Command copy and
this README say so plainly rather than guessing or scraping. A member's Steam profile and "Game details" must
be set to **Public** for stats to be fetchable; errors guide the member to that exact setting instead of
failing silently.

## Runtime status: unavailable without `STEAM_API_KEY`

`STEAM_API_KEY` is `requiredEnv`. Without it, `/plugin status` / this plugin's `health()` report `unavailable`,
every `/dbd` command replies with a "not available on this deployment" style message, and the background
refresh job no-ops. This is intentional, not a bug — same pattern as the `media` plugin's `MEDIA_PROVIDER` gate.

## Commands (`/dbd`)

| Subcommand         | Notes                                                                              |
| ------------------- | ----------------------------------------------------------------------------------- |
| `link <account>`   | Resolve a SteamID64/profile URL/vanity name, verify stats are fetchable, and save the link. Ephemeral. |
| `unlink`           | Delete the member's link and their stat snapshots in this guild. Ephemeral.        |
| `stats [member]`   | Stat card for self or another linked member. Public reply.                        |
| `leaderboard [stat]` | Top-10, paginated, for one curated stat. Public reply.                          |
| `refresh`          | Force-refresh the caller's own snapshot (rate-limited). Ephemeral.                 |

## Data model

- `GameAccountLink` — one linked external game account per member per guild per provider (`STEAM` is the only
  provider in v1), created by `/dbd link` and removed by `/dbd unlink`. Stores only the external account id
  (SteamID64) and a cached display name — never anything else from the provider's profile.
  `@@unique([guildId, provider, externalId])` additionally guarantees the same Steam account can't be linked by
  two different members in the same guild at once.
- `GameStatSnapshot` — the latest curated stat snapshot per member per game per guild. Only the stat keys the
  game descriptor displays are stored (e.g. escapes, kills, bloodpoints for Dead by Daylight) — never the
  provider's full stats payload. No history: each refresh overwrites the row. `lastError` (e.g. `private`) is
  surfaced back to the member instead of a stale/blank card.

## Permissions & intents

`SendMessages` + `EmbedLinks` (stat card / leaderboard replies). No privileged intents.

## Privacy notes

- Linking a Steam account stores only your SteamID64 and cached persona name — never your full Steam profile,
  friends list, or library.
- Stat snapshots store only the curated stat keys the linked game descriptor displays — never the provider's
  full stats payload.
- Latest snapshot only: refreshing a member's stats overwrites the previous snapshot, there is no history.
- Linking/unlinking is self-service (`/dbd link`, `/dbd unlink`) and is **not audited** — same reasoning as the
  community plugin's birthdays (no audit trail of personal, self-managed opt-in data).
- Steam-only: console platforms have no public stats API, so this feature never claims to support them.
- These rows are included in the guild data export (`apps/bot/src/host/data-requests.ts`) and deleted with the
  guild's data (cascade).

## Dashboard

None planned for v1 — every setting is member-self-service through `/dbd`.
