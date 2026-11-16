import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { defineManifest } from '../sdk';

/** Inclusive range for a role or channel XP multiplier. The stored value is clamped, not rejected. */
export const XP_MULTIPLIER_MIN = 0.25;
export const XP_MULTIPLIER_MAX = 5;

/**
 * Clamps one multiplier into {@link XP_MULTIPLIER_MIN}–{@link XP_MULTIPLIER_MAX}.
 * A non-finite value becomes 1, which does not change XP.
 */
export function clampXpMultiplier(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(XP_MULTIPLIER_MAX, Math.max(XP_MULTIPLIER_MIN, value));
}

const xpMultiplierEntrySchema = z.object({
  id: z.string().min(1),
  multiplier: z.number().transform((value) => clampXpMultiplier(value)),
});

const levelingSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * When true, the unauthenticated leaderboard and rank routes are available. Default `false` so a saved
   * config from before this key existed stays private.
   */
  publicLeaderboard: z.boolean().default(false),
  /** Minimum XP awarded per eligible message (SPEC.md §G "anti-farming controls"). */
  xpPerMessageMin: z.number().int().min(1).max(1000).default(15),
  xpPerMessageMax: z.number().int().min(1).max(1000).default(25),
  /** Per-user cooldown between XP-eligible messages, in seconds. */
  xpCooldownSeconds: z.number().int().min(0).max(3600).default(60),
  /** Hard cap on XP a single user can earn from messages in a rolling hour, regardless of cooldown. */
  maxXpPerHour: z.number().int().min(1).max(100_000).default(600),
  /** XP per minute spent in a voice channel with at least 2 other unmuted, non-bot members present. */
  voiceXpPerMinute: z.number().int().min(0).max(1000).default(5),
  ignoredChannelIds: z.array(z.string()).default([]),
  ignoredRoleIds: z.array(z.string()).default([]),
  /**
   * XP factor for members holding the role. Several matches: the highest wins (they are not multiplied).
   * The role factor and the channel factor then combine by max, not by product. Default `[]` so a saved
   * config from before this key existed still parses.
   */
  roleMultipliers: z.array(xpMultiplierEntrySchema).default([]),
  /**
   * XP factor for a channel. A thread matches its own id and its parent; the highest of those wins.
   * Voice uses the voice channel id only — a category is not a parent. Same max-combine rule as roles.
   */
  channelMultipliers: z.array(xpMultiplierEntrySchema).default([]),
  /** `'current'` | `'dm'` | `'none'` | a channel snowflake id. */
  levelUpChannel: z.string().default('current'),
  levelUpMessage: z.string().min(1).max(500).default('🎉 {user} just reached **level {level}**!'),
  rewardMode: z.enum(['stack', 'replace']).default('stack'),
});

const repSchema = z.object({
  enabled: z.boolean().default(true),
  cooldownHours: z.number().int().min(1).max(720).default(24),
});

const starboardSchema = z.object({
  channelId: z.string().nullable().default(null),
  emoji: z.string().min(1).max(64).default('⭐'),
  threshold: z.number().int().min(1).max(1000).default(5),
  ignoreSelfStar: z.boolean().default(true),
  allowNsfw: z.boolean().default(false),
});

const tempVoiceSchema = z.object({
  hubChannelIds: z.array(z.string()).default([]),
  categoryId: z.string().nullable().default(null),
  nameTemplate: z.string().min(1).max(100).default("{user}'s channel"),
  userLimit: z.number().int().min(0).max(99).default(0),
});

export const configSchema = z.object({
  leveling: levelingSchema.prefault({}),
  rep: repSchema.prefault({}),
  starboard: starboardSchema.prefault({}),
  tempVoice: tempVoiceSchema.prefault({}),
});

export type EngagementConfig = z.infer<typeof configSchema>;
export type EngagementRewardMode = EngagementConfig['leveling']['rewardMode'];
export type EngagementLevelingConfig = z.infer<typeof levelingSchema>;
export type EngagementRepConfig = z.infer<typeof repSchema>;
export type EngagementStarboardConfig = z.infer<typeof starboardSchema>;
export type EngagementTempVoiceConfig = z.infer<typeof tempVoiceSchema>;

export const manifest = defineManifest({
  id: 'engagement',
  name: 'Engagement',
  description:
    'Leveling/XP with anti-farming controls, leaderboards, a reputation system, a starboard, and temporary voice channels.',
  category: 'community',
  version: '0.1.0',
  defaultEnabled: true,
  permissions: [
    {
      permission: PermissionFlagsBits.ManageRoles,
      feature: 'level-up role rewards',
      optional: true,
      fallback: 'Level-ups still announce; role rewards are skipped and logged.',
    },
    {
      permission: PermissionFlagsBits.ManageChannels,
      feature: 'temporary voice channels',
      optional: true,
      fallback:
        'Members can still join a hub channel; the bot cannot create/rename/delete their temp channel.',
    },
    {
      permission: PermissionFlagsBits.Connect,
      feature: 'temporary voice channels (granting the owner Connect on their own channel, and managing it)',
      optional: true,
      fallback:
        'Discord rejects the owner overwrite, so no temp channel is created; the member stays in the hub channel.',
    },
    {
      permission: PermissionFlagsBits.MoveMembers,
      feature: 'temporary voice channels (moving the creator into their new channel)',
      optional: true,
      fallback: 'The temp channel is still created; the member has to move into it themselves.',
    },
    {
      permission: PermissionFlagsBits.MuteMembers,
      feature: 'temporary voice channels (owner can mute members in their own channel)',
      optional: true,
      fallback:
        'The temp voice owner cannot mute other members in their own channel; everything else still works.',
    },
    {
      permission: PermissionFlagsBits.DeafenMembers,
      feature: 'temporary voice channels (owner can deafen members in their own channel)',
      optional: true,
      fallback:
        'The temp voice owner cannot deafen other members in their own channel; everything else still works.',
    },
    {
      permission: PermissionFlagsBits.SendMessages,
      feature: 'level-up announcements, starboard posts',
      optional: false,
      fallback: 'Announcements/starboard posts silently fail to send; nothing else is affected.',
    },
    {
      permission: PermissionFlagsBits.EmbedLinks,
      feature: 'starboard posts, leaderboard/rank embeds',
      optional: false,
      fallback: 'Falls back to plain text where possible.',
    },
    {
      permission: PermissionFlagsBits.ReadMessageHistory,
      feature: 'starboard (reading reaction counts on older messages)',
      optional: true,
      fallback: 'Starboard may miss reactions added to messages the bot has not seen since restart.',
    },
  ],
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ],
  // Message content is never read for XP (message events fire on any eligible message regardless of content) —
  // only the starboard optionally quotes message content, and only when this intent is enabled (SPEC.md §G).
  privilegedIntents: ['MessageContent'],
  requiredEnv: [],
  configSchema,
  dashboard: { path: '/dashboard/[guildId]/engagement', label: 'Engagement', icon: 'trending-up' },
  privacyNotes: [
    'Leveling stores only aggregate counters (XP, level, message count, voice minutes) — never message content.',
    'Reputation stores who gave reputation to whom, an optional short free-text reason, and a timestamp.',
    'The starboard stores a link to the source message and its author; message content is only echoed into the starboard embed when the Message Content privileged intent is enabled for this bot, and even then only the message the members themselves starred.',
    'Temporary voice channels store the channel id, its creator, and which hub it was created from; the channel and its row are deleted automatically once empty.',
  ],
});
