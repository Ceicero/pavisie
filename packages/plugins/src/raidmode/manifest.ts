import { GatewayIntentBits, PermissionFlagsBits } from 'discord-api-types/v10';
import { z } from 'zod';
import { defineManifest } from '../sdk';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord id');

/** With automatic lockdown on, these are the lowest thresholds allowed, so ordinary traffic cannot lock a server. */
export const AUTO_LOCKDOWN_MIN_JOIN_THRESHOLD = 5;
export const AUTO_LOCKDOWN_MIN_NEW_ACCOUNT_SHARE_PCT = 20;

/** Per-server raid mode settings. Every threshold is the server admin's to set. */
export const configSchema = z
  .object({
    /** An incident starts when at least this many distinct members join within `windowSeconds`... */
    joinThreshold: z.number().int().min(3).max(1000).default(10),
    windowSeconds: z.number().int().min(5).max(600).default(30),
    /** ...and at least `newAccountSharePct` percent of them are accounts younger than this. */
    newAccountMaxAgeHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(72),
    newAccountSharePct: z.number().int().min(0).max(100).default(50),
    /** The incident is marked ended after this long with no join. A lockdown is never lifted automatically. */
    quietMinutes: z.number().int().min(1).max(240).default(5),
    /**
     * After an incident ends or a lockdown is restored, a new incident within this many minutes only alerts: it
     * never locks down automatically. Stops a handful of accounts from keeping a server closed by repeating a
     * small raid. An admin can still press "Lock down now".
     */
    autoLockdownCooldownMinutes: z.number().int().min(0).max(1440).default(30),
    /** Where the raid alert, its buttons, and the "lockdown still on" reminder are posted. */
    alertChannelId: snowflake.nullable().default(null),
    /** Detection and alerts only: no automatic lockdown. An admin can still press "Lock down now". */
    dryRun: z.boolean().default(true),
    /** Channels a lockdown closes. Empty = every channel the bot can manage (at most 100, in channel order). */
    lockdownChannelIds: z.array(snowflake).max(100).default([]),
    /** Also raise the server's verification level. Needs Manage Server, which is a manual grant. */
    raiseVerification: z.boolean().default(false),
    /** Also pause invites. Needs Manage Server, which is a manual grant. */
    pauseInvites: z.boolean().default(false),
  })
  .superRefine((config, issue) => {
    if (config.dryRun) return;
    if (config.joinThreshold < AUTO_LOCKDOWN_MIN_JOIN_THRESHOLD) {
      issue.addIssue({
        code: 'custom',
        path: ['joinThreshold'],
        message: `With automatic lockdown on, the join threshold must be at least ${AUTO_LOCKDOWN_MIN_JOIN_THRESHOLD}.`,
      });
    }
    if (config.newAccountSharePct < AUTO_LOCKDOWN_MIN_NEW_ACCOUNT_SHARE_PCT) {
      issue.addIssue({
        code: 'custom',
        path: ['newAccountSharePct'],
        message: `With automatic lockdown on, the new-account share must be at least ${AUTO_LOCKDOWN_MIN_NEW_ACCOUNT_SHARE_PCT}%.`,
      });
    }
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
    "Incident rows (counts, timestamps, and the ids of the staff who locked down or restored) are kept for the server's audit-log retention period, like the audit rows that record the same actions.",
    "Raid mode never bans or kicks. A lockdown only changes @everyone's channel permissions (and, if enabled, the verification level and invites), and restore puts back exactly what it changed.",
  ],
});
