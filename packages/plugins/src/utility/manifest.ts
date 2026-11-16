import { PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { defineManifest } from '../sdk';

export const configSchema = z.object({
  /** Whether `/utility afk` and the mention-reply behaviour are active in a guild. */
  afkEnabled: z.boolean().default(true),
  /** Default target language for `/utility translate` when `to` is omitted. ISO 639-1-ish code, adapter-specific. */
  translateDefaultTarget: z.string().min(2).max(10).default('en'),
  /** Unit system for `/utility weather`. */
  weatherUnits: z.enum(['metric', 'imperial']).default('metric'),
  /** When true, `/embed builder` requires at least `helper` staff level in addition to the Manage Messages permission. */
  embedBuilderStaffOnly: z.boolean().default(true),
});

export type UtilityConfig = z.infer<typeof configSchema>;

export const manifest = defineManifest({
  id: 'utility',
  name: 'Utility',
  description:
    'General-purpose utility commands: user/server info, timestamps, an embed builder, AFK, translation, weather, and bot health.',
  category: 'utility',
  version: '0.1.0',
  defaultEnabled: true,
  permissions: [
    {
      permission: PermissionFlagsBits.ViewChannel,
      feature:
        'help / userinfo / serverinfo / avatar / banner / roleinfo / channelinfo / timestamp / timezone / calculator / afk / translate / weather / status',
      optional: false,
      fallback:
        'Interaction responses are delivered over the interaction token, so no channel-level permission is required for these read-only commands.',
    },
    {
      permission: PermissionFlagsBits.EmbedLinks,
      feature: 'Rich embeds in command replies',
      optional: true,
      fallback:
        'Without Embed Links the bot can still reply, but Discord may render embeds as plain links in some contexts.',
    },
    {
      permission: PermissionFlagsBits.SendMessages,
      feature: '/embed builder (send to channel)',
      optional: true,
      fallback:
        '"Send to channel" checks the bot can view, send, and embed in the target channel and replies with an error if it cannot; every other utility command is unaffected. (Manage Messages is required of the member running /embed, never of the bot.)',
    },
  ],
  intents: [],
  // Automatic AFK-mention replies only need to see who was @mentioned, which arrives on every message
  // regardless of the Message Content intent; nothing in this plugin reads message text.
  requiredEnv: [],
  optionalEnv: [
    'TRANSLATE_PROVIDER',
    'DEEPL_API_KEY',
    'LIBRETRANSLATE_URL',
    'LIBRETRANSLATE_API_KEY',
    'WEATHER_PROVIDER',
    'OPENWEATHERMAP_API_KEY',
  ],
  configSchema,
  // Deliberately no `dashboard` entry: utility is configured entirely through the plugin config drawer
  // (auto-generated from `configSchema`) on `/dashboard/[guildId]/plugins`, per this build task's explicit
  // instructions. Do not add a dedicated dashboard page/route for this plugin.
  privacyNotes: [
    '`/utility afk` stores only the optional AFK message you provide and the time you went AFK (`AfkStatus`); it is cleared automatically the next time you send a message.',
    '`/utility timezone set` stores an IANA timezone string on your cross-guild `UserProfile`, used only to render `/utility timestamp` output in your local time.',
    '`/utility translate` and `/utility weather` send only the text/location you provide to the configured third-party adapter (DeepL, LibreTranslate, Open-Meteo, or OpenWeatherMap) — never full message history — and only when an operator has configured a provider.',
    'The embed builder does not store anything; the preview lives only in the ephemeral interaction and (briefly) in Redis while you edit it.',
  ],
});
