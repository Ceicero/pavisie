import { GatewayIntentBits, PermissionFlagsBits } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineManifest } from '../sdk';
import { ENFORCER_DECISIONS } from './schemas';

const requireReasonDecisionSchema = z.enum(['warn', 'timeout', 'mute', 'kick', 'ban']);

export const configSchema = z.object({
  ledgerChannelId: z.string().nullable().default(null),
  ledgerVisibility: z.enum(['staff', 'everyone']).default('staff'),
  flagChannelId: z.string().nullable().default(null),
  muteRoleId: z.string().nullable().default(null),
  captureContext: z.boolean().default(true),
  contextBefore: z.number().int().min(1).max(15).default(5),
  contextAfter: z.number().int().min(0).max(10).default(3),
  excerptMaxChars: z.number().int().min(50).max(1000).default(300),
  autoFlagEnabled: z.boolean().default(true),
  exemptStaff: z.boolean().default(true),
  aiAssist: z.boolean().default(false),
  dmOnAction: z.boolean().default(true),
  defaultTimeoutMinutes: z.number().int().min(1).max(40320).default(60),
  /** `null` = mute is indefinite (until `/enforcer unmute` or a manual role removal). */
  defaultMuteMinutes: z.number().int().min(1).max(40320).nullable().default(null),
  requireReasonOn: z.array(requireReasonDecisionSchema).default(['kick', 'ban']),
  allowedDecisions: z.array(z.enum(ENFORCER_DECISIONS)).default([...ENFORCER_DECISIONS]),
  banDeleteMessageSeconds: z.number().int().min(0).max(604800).default(0),
});

export type EnforcerConfig = z.infer<typeof configSchema>;

export const manifest = defineManifest({
  id: 'enforcer',
  name: 'Enforcer',
  description:
    'Policy-driven, hands-off moderation: the bot flags possible violations from a server policy and a moderator decides — everything is bookkept in a read-only ledger and the database. Moderators never DM or confront the suspect directly; the bot mediates every action.',
  category: 'moderation',
  version: '0.1.0',
  defaultEnabled: false,
  permissions: [
    {
      permission: PermissionFlagsBits.ViewChannel,
      feature: 'reading the ledger, flag-queue, and flagged channels',
      optional: false,
      fallback: 'Enforcer cannot read the channels it needs and will report itself unavailable.',
    },
    {
      permission: PermissionFlagsBits.SendMessages,
      feature: 'posting ledger entries and flag-queue embeds',
      optional: false,
      fallback: 'Ledger entries and flag posts fail; `/enforcer setup` reports the missing permission.',
    },
    {
      permission: PermissionFlagsBits.EmbedLinks,
      feature: 'ledger entries and flag-queue embeds',
      optional: false,
      fallback: 'Falls back to a much plainer message where possible.',
    },
    {
      permission: PermissionFlagsBits.ReadMessageHistory,
      feature: '"View context" (surrounding messages) on a flag',
      optional: false,
      fallback:
        'Context snapshots and live context lookups are unavailable; only the flagged message itself (and its jump link) are shown.',
    },
    {
      permission: PermissionFlagsBits.ManageChannels,
      feature: 'creating/repairing the ledger and flag-queue channels during `/enforcer setup`',
      optional: true,
      fallback:
        'You must create the channels yourself and pick them in the setup wizard; permission overwrites will not be applied automatically.',
    },
    {
      permission: PermissionFlagsBits.ManageRoles,
      feature: 'creating the mute role and applying MUTE/UNMUTE decisions',
      optional: true,
      fallback: 'The Mute decision is unavailable; you must create/assign a mute role manually.',
    },
    {
      permission: PermissionFlagsBits.Speak,
      feature: 'denying Speak to the mute role in voice channels (part of the mute-role overwrite)',
      optional: true,
      fallback:
        'Discord rejects the mute-role overwrite on a channel when the bot does not itself hold a permission it denies; `/enforcer setup` and repair report those channels as failed.',
    },
    {
      permission: PermissionFlagsBits.ModerateMembers,
      feature: 'the Timeout decision (routed through the moderation plugin)',
      optional: true,
      fallback: 'The Timeout decision is disabled in the flag-queue until this permission is granted.',
    },
    {
      permission: PermissionFlagsBits.KickMembers,
      feature: 'the Kick decision',
      optional: true,
      fallback: 'The Kick decision is disabled in the flag-queue until this permission is granted.',
    },
    {
      permission: PermissionFlagsBits.BanMembers,
      feature: 'the Ban decision',
      optional: true,
      fallback: 'The Ban decision is disabled in the flag-queue until this permission is granted.',
    },
  ],
  // Auto-flagging (events/message-create.ts) listens to `messageCreate`, which needs GuildMessages. This
  // currently "worked" only because other loaded plugins (automod/logging/tickets/engagement) also declare
  // GuildMessages and the registry unions every loaded plugin's intents — but the manifest itself must state
  // what this plugin actually needs to be accurate documentation and safe if that ever changes.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  privilegedIntents: ['MessageContent'],
  requiredEnv: [],
  configSchema,
  dashboard: { path: '/dashboard/[guildId]/enforcer', label: 'Enforcer', icon: 'scale' },
  privacyNotes: [
    'Enforcer stores a sanitized excerpt of the flagged message, and — only when "Capture context" is enabled (on by default) — a short snapshot of the messages immediately before it, so a moderator can read the exact chat context without confronting the suspect directly.',
    'Turning "Capture context" off in `/enforcer setup` (or the dashboard Settings tab) stops all excerpt/context storage; flags then carry only a jump link to the live message, which may no longer exist by the time it is reviewed.',
    'Automatic flagging (matching messages as they are sent) only runs when the server has enabled the Message Content privileged intent; without it, Enforcer still works in fully manual mode (context-menu "Flag for review" and `/enforcer flag`), which always has the message content available regardless of intent.',
    'Ledger entries and database records are the source of truth for every flag and decision, retained per the server\'s moderation-case retention policy, and are visible to staff (optionally server-wide if the admin sets ledger visibility to "everyone").',
    'When "AI assist" is turned on, the flagged content (and the matched policy name, if any) is sent to the server\'s configured AI provider to generate a risk score and one-sentence explanation. It never decides or acts on its own — a moderator still reviews and picks the outcome.',
  ],
});
