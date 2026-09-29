import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { defineManifest } from '../sdk';

// Almost all of this plugin's state lives in `IntegrationConnection`/`WebhookEndpoint`/`OAuthToken` rows
// (per-connection, not per-guild-plugin-config) — there is no meaningful per-guild config to store here.
export const configSchema = z.object({});
export type IntegrationsConfig = z.infer<typeof configSchema>;

export const manifest = defineManifest({
  id: 'integrations',
  name: 'Integrations',
  description:
    'Secure connector framework for optional external services: Twitch, YouTube, Instagram, Reddit, Steam, Google/Microsoft Calendar, and generic webhooks.',
  category: 'integrations',
  version: '0.1.0',
  defaultEnabled: false,
  permissions: [
    {
      permission: PermissionFlagsBits.ViewChannel,
      feature: 'posting alerts / inbound webhook events',
      optional: false,
      fallback: 'Alerts silently fail to post in that channel; connection health shows an error.',
    },
    {
      permission: PermissionFlagsBits.SendMessages,
      feature: 'posting alerts / inbound webhook events',
      optional: false,
      fallback: 'Alerts silently fail to post in that channel; connection health shows an error.',
    },
    {
      permission: PermissionFlagsBits.EmbedLinks,
      feature: 'alert embeds (Twitch/YouTube/Instagram/Reddit/Steam/Calendar)',
      optional: true,
      fallback: 'Alerts post as plain text instead of a rich embed.',
    },
  ],
  intents: [GatewayIntentBits.Guilds],
  requiredEnv: [],
  // Every provider is optional; the plugin degrades per-connection when a given provider's vars are unset.
  optionalEnv: [
    'TWITCH_CLIENT_ID',
    'TWITCH_CLIENT_SECRET',
    'TWITCH_EVENTSUB_SECRET',
    'YOUTUBE_API_KEY',
    'GITHUB_WEBHOOK_SECRET',
    'REDDIT_CLIENT_ID',
    'REDDIT_CLIENT_SECRET',
    'REDDIT_USER_AGENT',
    'STEAM_API_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'MICROSOFT_CLIENT_ID',
    'MICROSOFT_CLIENT_SECRET',
    'INSTAGRAM_CLIENT_ID',
    'INSTAGRAM_CLIENT_SECRET',
    'PUBLIC_WEBHOOK_BASE_URL',
  ],
  configSchema,
  dashboard: { path: '/dashboard/[guildId]/integrations', label: 'Integrations', icon: 'plug' },
  privacyNotes: [
    'OAuth access/refresh tokens are encrypted at rest (AES-256-GCM) and only decrypted in-process to make an API call.',
    'Inbound/outbound webhook secrets are encrypted at rest and shown in plaintext exactly once, at creation time.',
    'Alert connectors (Twitch/YouTube/Reddit/Steam) only read publicly available data about the watched target — no message content or member data is sent to any provider.',
    "Instagram reads only the connected account's own media via the official Instagram API with Instagram Login (own-account OAuth connect, not the watched-target model above) — it cannot look up or read any other account's posts.",
    'Outbound webhook payloads are whatever the triggering platform event carries (case numbers, user ids, reasons) — never raw message content.',
    'Twitch chat bot (run for the streamer and managed on the creator dashboard, not in this server): chat messages are parsed in memory only, to match a command — never persisted, logged, or sent to Discord.',
    'Discord ↔ Twitch chat bridge (opt-in, off by default per direction, set up by the streamer on the creator dashboard for a server they connected): messages posted in the bridged Discord channel and/or Twitch chat are shown on the other platform — text and display names are relayed in memory only, never stored or logged by Pavisie. It only runs while this plugin is on in the server.',
  ],
});
