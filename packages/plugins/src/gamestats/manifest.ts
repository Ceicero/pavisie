import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { defineManifest } from '../sdk';

// No per-guild config yet — v1 has nothing worth exposing (member opt-in state lives on `GameAccountLink`/
// `GameStatSnapshot` rows, not here), matching the `integrations` plugin's config-less shape.
export const configSchema = z.object({});
export type GamestatsConfig = z.infer<typeof configSchema>;

export const manifest = defineManifest({
  id: 'gamestats',
  name: 'Game Stats',
  description:
    "Per-guild leaderboards comparing members' game stats. Members opt in by linking their Steam account; stats are fetched from the public Steam Web API. Steam-only (no public API exists for console platforms) — first game: Dead by Daylight.",
  category: 'community',
  version: '0.1.0',
  defaultEnabled: false,
  permissions: [
    {
      permission: PermissionFlagsBits.SendMessages,
      feature: 'stat card / leaderboard replies',
      optional: false,
      fallback: 'The command replies with an error instead of the stat card/leaderboard.',
    },
    {
      permission: PermissionFlagsBits.EmbedLinks,
      feature: 'stat card / leaderboard embeds',
      optional: false,
      fallback: 'Falls back to plain text where possible.',
    },
  ],
  intents: [GatewayIntentBits.Guilds],
  // Unavailable (see /plugin status) without a Steam Web API key: every command replies "not available on
  // this deployment" and the refresh job no-ops, rather than guessing or scraping. See integrations/manifest.ts
  // for the same optionalEnv declaration used by the (unrelated) Steam app-news alert connector.
  requiredEnv: ['STEAM_API_KEY'],
  configSchema,
  // Deliberately no `dashboard` entry yet: v1 has no per-guild config worth a dedicated page (matches
  // media/manifest.ts's reasoning) — members manage their own link with `/dbd link|unlink`.
  privacyNotes: [
    'Linking is self-reported and unverified: a member pastes a SteamID64/profile URL/vanity name — there is no Steam sign-in, so Pavisie cannot confirm the account actually belongs to them.',
    'The only guard against misuse is that the same Steam account cannot be linked by more than one member in the same server at once — linking an account already claimed there is rejected.',
    'Linking a Steam account stores only your SteamID64 and cached persona name — never your full Steam profile, friends list, or library.',
    "Stat snapshots store only the curated stat keys the linked game descriptor displays (e.g. escapes, kills, bloodpoints for Dead by Daylight) — never the provider's full stats payload.",
    "Latest snapshot only: refreshing a member's stats overwrites the previous snapshot, there is no history.",
    "Linking/unlinking is self-service (`/dbd link`, `/dbd unlink`) and is not audited, matching the community plugin's birthdays.",
    'Steam-only: console platforms have no public stats API, so this feature never claims to support them.',
    'Your Steam profile and game details must be set to Public for stats to be fetchable — Pavisie never guesses or bypasses privacy settings.',
  ],
});
