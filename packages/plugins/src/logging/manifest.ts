import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { defineManifest } from '../sdk';
import { ALL_LOG_KINDS, REDACTION_PATTERN_MAX, REDACTION_PATTERN_MAX_LENGTH } from './constants';

const logKindSchema = z.enum(ALL_LOG_KINDS);
const channelKeySchema = z.union([logKindSchema, z.literal('default')]);

/** `Record<LogKind | 'default', string | null>` (ARCHITECTURE.md's logging task config schema), default `{}` — an absent key simply has no channel configured. */
const channelsSchema = z.partialRecord(channelKeySchema, z.string().nullable()).prefault({});

export const configSchema = z.object({
  channels: channelsSchema,
  enabledKinds: z.array(logKindSchema).default([...ALL_LOG_KINDS]),
  storeEvents: z.boolean().default(true),
  retentionDays: z.number().int().min(1).max(3650).default(90),
  redactionPatterns: z
    .array(z.string().min(1).max(REDACTION_PATTERN_MAX_LENGTH))
    .max(REDACTION_PATTERN_MAX)
    .default([]),
  /** Effective only together with `GuildConfig.logMessageContent` (core, guild-wide) — both must be on for message content to appear in edit/delete logs. */
  captureContent: z.boolean().default(false),
});

export type LoggingConfig = z.infer<typeof configSchema>;

export const manifest = defineManifest({
  id: 'logging',
  name: 'Logging',
  description:
    'Routes member, message, role, channel, moderation, voice, and platform events to configured log channels, with redaction, retention, and a searchable dashboard audit log.',
  category: 'moderation',
  version: '0.1.0',
  defaultEnabled: true,
  permissions: [
    {
      permission: PermissionFlagsBits.ViewChannel,
      feature: 'posting log embeds to configured log channels',
      optional: false,
      fallback: 'that channel is skipped and an error is logged',
    },
    {
      permission: PermissionFlagsBits.SendMessages,
      feature: 'posting log embeds to configured log channels',
      optional: false,
      fallback: 'that channel is skipped and an error is logged',
    },
    {
      permission: PermissionFlagsBits.EmbedLinks,
      feature: 'rich log embeds (title/fields/jump links)',
      optional: false,
      fallback: 'Discord blocks the send entirely, so the log embed is dropped',
    },
    {
      permission: PermissionFlagsBits.ReadMessageHistory,
      feature: 'live message-edit/delete diffing and invite-use context',
      optional: true,
      fallback: 'edits/deletes are still logged from cached data only',
    },
    {
      permission: PermissionFlagsBits.ManageGuild,
      feature: 'invite-use attribution on member join (`invite.use`)',
      optional: true,
      fallback: 'member joins are still logged, just without which invite was used',
    },
  ],
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildInvites,
  ],
  privilegedIntents: ['GuildMembers', 'MessageContent'],
  requiredEnv: [],
  configSchema,
  dashboard: { path: '/dashboard/[guildId]/logging', label: 'Logging', icon: 'scroll-text' },
  privacyNotes: [
    'No message content is captured by default. Edit/delete logs record metadata only unless both the server-wide "Log message content" setting and this plugin\'s "Capture content" setting are on.',
    'Log payloads are redacted before storage and display: emails, phone numbers, Discord tokens, credit-card-like numbers, and IPv4 addresses are replaced with placeholders by default, plus any custom regex patterns an admin adds.',
    'Stored log events (LogEvent rows) are purged automatically after the configured retention period, capped by the server\'s overall data retention policy. Turn off "Store events" to stop persisting them entirely (log channels still receive live embeds).',
  ],
});
