import { z } from 'zod';
import { defineManifest } from '../sdk';

export const configSchema = z.object({
  /** Mirrors `GuildConfig.fastActions` (core, authoritative) so this plugin's own config carries a readable copy. */
  fastActions: z.boolean().default(false),
  /** Set once `/setup wizard` completes; mirrors `GuildConfig.setupCompletedAt !== null`. */
  setupCompleted: z.boolean().default(false),
  /** Mirrors `GuildConfig.staffChannelId` (core, authoritative). */
  staffChannelId: z.string().nullable().default(null),
});

export type AdminConfig = z.infer<typeof configSchema>;

export const manifest = defineManifest({
  id: 'admin',
  name: 'Admin',
  description:
    "Guided server setup, core configuration, plugin enable/disable, permission auditing, and bot health — the platform's always-on control plane.",
  category: 'admin',
  version: '0.1.0',
  defaultEnabled: true,
  alwaysEnabled: true,
  // Every admin command replies via the interaction (ephemeral or otherwise), which needs no channel-level bot
  // permission at all — Discord delivers interaction responses over the interaction token, not a regular
  // channel send. Nothing to declare here.
  permissions: [],
  intents: [],
  requiredEnv: [],
  configSchema,
  dashboard: { path: '/dashboard/[guildId]/settings', label: 'Settings', icon: 'settings' },
  privacyNotes: [
    'Every configuration change (setup wizard, /config set, plugin enable/disable) is written to the audit log with the actor, timestamp, and a redacted before/after diff.',
    "/pavisie report sends a message to the Pavisie developer, shown before submission: only the kind/subject/body you type in that command, plus this server's id and name, your user id and tag, a timestamp, and the bot version leave this server. Nothing else is captured (no surrounding messages, channel history, or member lists). A record is written to this server's own audit log so other admins can see a report was sent. Hard per-user/per-guild rate limits apply.",
  ],
});
