import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { defineManifest } from '../sdk';

/** One intake question shown to the ticket opener in a modal (short text or paragraph). Max 5 per form. */
const intakeFieldSchema = z.object({
  label: z.string().trim().min(1).max(100),
  style: z.enum(['short', 'paragraph']).default('short'),
  required: z.boolean().default(true),
});

export const configSchema = z.object({
  /** Default support roles for tickets not opened from a panel (a panel may override this with its own list). */
  supportRoleIds: z.array(z.string()).default([]),
  /** Default parent category for CHANNEL-mode tickets not opened from a panel. */
  categoryId: z.string().nullable().default(null),
  /** Default ticket mode for tickets not opened from a panel. */
  mode: z.enum(['channel', 'thread']).default('channel'),
  /** Channel the closing summary + HTML transcript is posted to. */
  transcriptChannelId: z.string().nullable().default(null),
  transcriptRetentionDays: z.number().int().positive().max(3650).default(90),
  /** DM the opener their transcript when the ticket closes. */
  dmTranscript: z.boolean().default(false),
  /** Default SLA (minutes to first staff response) for tickets not opened from a panel; null = no SLA. */
  slaMinutes: z.number().int().positive().max(43200).nullable().default(null),
  maxOpenPerUser: z.number().int().min(1).max(10).default(1),
  reopenWindowHours: z.number().int().min(0).max(720).default(24),
  /** Seconds to wait before deleting a closed CHANNEL-mode ticket's channel; 0 deletes immediately. */
  deleteAfterCloseSeconds: z.number().int().min(0).max(604800).default(30),
  /** When true, closed CHANNEL-mode channels are never auto-deleted (opener access is still revoked). */
  keepClosedChannels: z.boolean().default(false),
  /** Snapshot copied onto a new panel's `intakeForm` when its "intake" toggle is on at creation time. */
  intakeForm: z.array(intakeFieldSchema).max(5).default([]),
  /** Channel the SLA-breach job posts staff alerts to, in addition to the ticket itself. */
  alertChannelId: z.string().nullable().default(null),
});

export type TicketsConfig = z.infer<typeof configSchema>;
export type TicketIntakeField = z.infer<typeof intakeFieldSchema>;

export const manifest = defineManifest({
  id: 'tickets',
  name: 'Tickets',
  description:
    'Button-driven support tickets with categories, staff assignment, tags, and HTML/JSON transcripts.',
  category: 'community',
  version: '0.1.0',
  defaultEnabled: false,
  permissions: [
    {
      permission: PermissionFlagsBits.ManageChannels,
      feature: 'creating and deleting ticket channels (channel mode)',
      optional: true,
      fallback:
        'Channel-mode tickets fail with a clear ephemeral error when opened; thread-mode tickets still work.',
    },
    {
      permission: PermissionFlagsBits.ManageRoles,
      feature: 'setting per-user/per-role permission overwrites on a new ticket channel',
      optional: true,
      fallback:
        'Channel-mode tickets fail with a clear ephemeral error when opened; thread-mode tickets still work.',
    },
    {
      permission: PermissionFlagsBits.CreatePrivateThreads,
      feature: 'creating private ticket threads (thread mode)',
      optional: true,
      fallback:
        'Thread-mode tickets fail with a clear ephemeral error when opened; channel-mode tickets still work.',
    },
    {
      permission: PermissionFlagsBits.SendMessagesInThreads,
      feature:
        'posting the opening embed and the "ticket closed" notice with its Reopen button inside a ticket thread (thread mode)',
      optional: true,
      fallback:
        'The ticket thread is still created, but the opening embed and the closed notice with its Reopen button are not posted in it; channel-mode tickets are unaffected.',
    },
    {
      permission: PermissionFlagsBits.ManageThreads,
      feature: 'archiving and locking ticket threads on close, and adding participants to a thread',
      optional: true,
      fallback:
        'Thread-mode tickets close but the thread is left unarchived/unlocked for staff to close manually.',
    },
    {
      permission: PermissionFlagsBits.SendMessages,
      feature: 'posting the panel, opening embed, and closing summary',
      optional: false,
      fallback: 'The plugin cannot function without this permission.',
    },
    {
      permission: PermissionFlagsBits.EmbedLinks,
      feature: 'rich panel/ticket embeds',
      optional: true,
      fallback: 'Falls back to plain-text messages.',
    },
    {
      permission: PermissionFlagsBits.AttachFiles,
      feature: 'delivering the HTML transcript file to the transcript channel/DM',
      optional: true,
      fallback:
        'The transcript is still saved and downloadable from the dashboard, just not attached in Discord.',
    },
    {
      permission: PermissionFlagsBits.ReadMessageHistory,
      feature: 'building transcripts from the ticket channel/thread history',
      optional: true,
      fallback: 'Transcripts record only the closing event, with no message history.',
    },
  ],
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  // Discord withholds `content`/`attachments`/`embeds` on Message objects (gateway AND REST) from bots that
  // lack this privileged intent, for any message that doesn't mention the bot and isn't a DM — including the
  // `channel.messages.fetch()` calls transcripts are built from. Without it, transcripts still record who said
  // something and when, just not the text itself.
  privilegedIntents: ['MessageContent'],
  requiredEnv: [],
  configSchema,
  dashboard: { path: '/dashboard/[guildId]/tickets', label: 'Tickets', icon: 'ticket' },
  privacyNotes: [
    'Ticket transcripts (JSON and HTML) store the full message history of the ticket channel/thread, including message text, so staff and the ticket opener have a record of what was discussed. Transcripts are retained for `transcriptRetentionDays` (default 90) and then purged by the retention job.',
    'Full message text in transcripts requires the Message Content privileged intent (see `/plugin status tickets`); without it, transcripts record only message metadata (author, time, attachment links), not text.',
    'Intake form answers (if a panel collects them) are stored on the ticket record and included in transcripts.',
  ],
});
