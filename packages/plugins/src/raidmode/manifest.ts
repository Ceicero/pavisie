import { GatewayIntentBits, PermissionFlagsBits } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineManifest } from '../sdk';

/** Per-server raid mode settings. Every threshold is the server admin's to set. */
export const configSchema = z.object({
  /** An incident starts when at least this many members join within `windowSeconds`... */
  joinThreshold: z.number().int().min(3).max(1000).default(10),
  windowSeconds: z.number().int().min(5).max(600).default(30),
  /** ...and at least `newAccountSharePct` percent of those joins are accounts younger than this. */
  newAccountMaxAgeHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(72),
  newAccountSharePct: z.number().int().min(0).max(100).default(50),
  /** The incident is marked ended after this long with no join. A lockdown is never lifted automatically. */
  quietMinutes: z.number().int().min(1).max(240).default(5),
  /** Where the raid alert, its buttons, and the "lockdown still on" reminder are posted. */
  alertChannelId: z.string().nullable().default(null),
  /** Detection and alerts only: no automatic lockdown. An admin can still press "Lock down now". */
  dryRun: z.boolean().default(true),
  /** Channels a lockdown closes. Empty = every text channel the bot can manage (at most 100). */
  lockdownChannelIds: z.array(z.string()).max(100).default([]),
  /** Also raise the server's verification level. Needs Manage Server, which is a manual grant. */
  raiseVerification: z.boolean().default(false),
  /** Also pause invites. Needs Manage Server, which is a manual grant. */
  pauseInvites: z.boolean().default(false),
});

export type RaidModeConfig = z.infer<typeof configSchema>;

export const manifest = defineManifest({
  id: 'raidmode',
  name: 'Raid mode',
  description:
    'Detects raids from join rate and account age, locks channels down with one-click exact restore, and scores risky joins with as little stored data as possible.',
  category: 'moderation',
  version: '0.1.0',
  defaultEnabled: false,
  permissions: [
    {
      permission: PermissionFlagsBits.ViewChannel,
      feature: 'seeing the channels a lockdown closes, and the alert channel',
      optional: false,
      fallback: 'Channels the bot cannot see are left out of a lockdown.',
    },
    {
      permission: PermissionFlagsBits.SendMessages,
      feature: 'posting the raid alert and the "lockdown still on" reminder',
      optional: false,
      fallback: 'No alert is posted; incidents are still recorded and shown on the dashboard.',
    },
    {
      permission: PermissionFlagsBits.EmbedLinks,
      feature: 'the raid alert embed',
      optional: false,
      fallback: 'The alert cannot be posted.',
    },
    {
      permission: PermissionFlagsBits.ManageRoles,
      feature: 'changing and restoring the @everyone channel overwrites during a lockdown',
      optional: true,
      fallback: 'Lockdown skips every channel; staff are told nothing was locked.',
    },
    {
      permission: PermissionFlagsBits.ManageGuild,
      feature: 'raising the verification level and pausing invites during a lockdown (manual grant)',
      optional: true,
      fallback: 'Those two lockdown options are skipped; channel lockdown still works.',
    },
  ],
  intents: [GatewayIntentBits.Guilds],
  // guildMemberAdd needs the privileged Server Members intent; without it raid mode never sees a join.
  privilegedIntents: ['GuildMembers'],
  requiredEnv: [],
  configSchema,
  privacyNotes: [
    'Incidents store counts and timestamps only: no usernames, avatars, invite codes, IP addresses or message content.',
    'Risk scores are kept only for medium- and high-risk joins during a raid: the member id, a 0–100 score and short reason codes. They are deleted 30 days after the incident ends.',
    "Raid mode never bans or kicks. A lockdown only changes @everyone's channel permissions (and, if enabled, the verification level and invites), and restore puts back exactly what it changed.",
  ],
});
