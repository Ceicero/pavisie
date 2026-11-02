import { z } from 'zod';
import { defineManifest } from '../sdk';

export const trackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string().optional(),
  durationSec: z.number().nonnegative().optional(),
  url: z.string(),
  provider: z.string(),
  thumbnailUrl: z.string().optional(),
});

export const playlistSchema = z.object({
  name: z.string().min(1).max(100),
  tracks: z.array(trackSchema).max(200),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type MediaPlaylist = z.infer<typeof playlistSchema>;

export const configSchema = z.object({
  /** When set, only members with this role may use mutating `/music` subcommands (see `dj-gate.ts`). */
  djRoleId: z.string().nullable().default(null),
  defaultVolume: z.number().int().min(0).max(150).default(100),
  /** Saved playlists, keyed by (lowercased) name — `/music playlist save|load|list|delete`. */
  playlists: z.record(z.string(), playlistSchema).prefault({}),
});
export type MediaConfig = z.infer<typeof configSchema>;

export const manifest = defineManifest({
  id: 'media',
  name: 'Music & Media',
  description:
    'Playlist and queue management for a legal, user-authorized audio source. Unavailable unless MEDIA_PROVIDER names a compliant provider — no YouTube scraping, stream ripping, or copyright bypassing.',
  category: 'media',
  version: '0.1.0',
  defaultEnabled: false,
  permissions: [],
  intents: [],
  // Unavailable (see /plugin status) until a compliant provider is configured, per SPEC.md §I. Note that
  // `requiredEnv` only checks the var is *set* — `MEDIA_PROVIDER=none` (the platform default) still counts as
  // "set", so every command additionally checks `resolveMediaProvider(...).isConfigured(...)` itself and
  // explains the compliance reason directly (see `commands/music.ts`), rather than relying solely on this gate.
  requiredEnv: ['MEDIA_PROVIDER'],
  optionalEnv: ['EXAMPLE_LICENSED_API_KEY'],
  configSchema,
  // Deliberately no `dashboard` entry: media is configured entirely through `/music` (djRoleId, defaultVolume)
  // via the plugin config drawer on `/dashboard/[guildId]/plugins`, matching utility/economy. No dedicated
  // `/dashboard/[guildId]/media` page exists — a `dashboard` entry here would produce a dead "Configure" link
  // (apps/api/src/routes/plugins.ts surfaces `manifest.dashboard?.path` to the dashboard's Plugins list).
  privacyNotes: [
    'No audio, message content, or listening history is stored — only track metadata (title/artist/URL/duration) for the current queue and any playlists staff explicitly save.',
    'This plugin never scrapes, rips, or re-hosts audio from any platform. It only queues track references for a provider whose own API/terms permit bot playback.',
  ],
});
