// DTOs for the `engagement` plugin (leveling/XP, reputation, starboard, temp voice).
// Owned by the engagement build agent (ARCHITECTURE.md §7.1). Kept independent of
// `packages/plugins`' zod schema (which must stay structurally compatible with this file)
// so `apps/api` and `apps/dashboard` never need to depend on `@pavisie/plugins` (discord.js).

/** `rewardMode` governs whether level-role rewards stack (keep every earned role) or replace (keep only the highest earned). */
export type EngagementRewardMode = 'stack' | 'replace';

/** `levelUpChannel`: `'current'` (the channel the message was sent in), `'dm'`, `'none'`, or a channel snowflake id. */
export type EngagementLevelUpChannel = 'current' | 'dm' | 'none' | string;

/**
 * One role or channel XP multiplier. `multiplier` is clamped to 0.25–5 when the config is parsed.
 * Several matching roles (or the thread channel and its parent) keep the highest value. The role
 * result and the channel result are then combined by taking the max, not the product.
 */
export interface EngagementXpMultiplier {
  id: string;
  multiplier: number;
}

export interface EngagementLevelingConfig {
  enabled: boolean;
  /** When true, the unauthenticated leaderboard and rank routes are available. Off by default. */
  publicLeaderboard: boolean;
  xpPerMessageMin: number;
  xpPerMessageMax: number;
  xpCooldownSeconds: number;
  maxXpPerHour: number;
  voiceXpPerMinute: number;
  ignoredChannelIds: string[];
  ignoredRoleIds: string[];
  roleMultipliers: EngagementXpMultiplier[];
  channelMultipliers: EngagementXpMultiplier[];
  levelUpChannel: EngagementLevelUpChannel;
  levelUpMessage: string;
  rewardMode: EngagementRewardMode;
}

export interface EngagementRepConfig {
  enabled: boolean;
  cooldownHours: number;
}

export interface EngagementStarboardConfig {
  channelId: string | null;
  emoji: string;
  threshold: number;
  ignoreSelfStar: boolean;
  allowNsfw: boolean;
}

export interface EngagementTempVoiceConfig {
  hubChannelIds: string[];
  categoryId: string | null;
  nameTemplate: string;
  userLimit: number;
}

/** Effective per-guild `engagement` plugin config (matches `packages/plugins/src/engagement/manifest.ts`'s `configSchema`). */
export interface EngagementConfigDto {
  leveling: EngagementLevelingConfig;
  rep: EngagementRepConfig;
  starboard: EngagementStarboardConfig;
  tempVoice: EngagementTempVoiceConfig;
}

/** One row of the leveling leaderboard / `/level rank` lookup. */
export interface LevelProfileDto {
  userId: string;
  xp: number;
  level: number;
  messages: number;
  voiceMinutes: number;
  /** 1-based position on a leaderboard page (`offset + index + 1`). Omitted by endpoints that don't compute it. */
  rank?: number;
}

/** One public leaderboard row. No other member fields are included. */
export interface PublicLeaderboardEntryDto {
  rank: number;
  userId: string;
  username: string | null;
  globalName: string | null;
  avatarUrl: string | null;
  xp: number;
  level: number;
  messages: number;
  voiceMinutes: number;
}

/** Unauthenticated leveling leaderboard. `404` when the toggle is off or the bot is not in the guild. */
export interface PublicLeaderboardDto {
  guildId: string;
  items: PublicLeaderboardEntryDto[];
  nextCursor: string | null;
  total: number;
}

/** Unauthenticated `/level rank` payload. `404` when the toggle is off, the bot is absent, or there is no profile. */
export interface PublicRankDto {
  userId: string;
  username: string | null;
  globalName: string | null;
  avatarUrl: string | null;
  rank: number;
  level: number;
  xp: number;
  intoLevel: number;
  span: number;
  messages: number;
  voiceMinutes: number;
}

export interface LevelRewardDto {
  id: string;
  guildId: string;
  level: number;
  roleId: string;
  createdAt: string;
}

/** One row of the reputation leaderboard: a user's net reputation total in the guild. */
export interface ReputationLeaderboardEntryDto {
  userId: string;
  total: number;
  eventCount: number;
}

export interface ReputationEventDto {
  id: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  reason: string | null;
  createdAt: string;
}

export interface StarboardEntryDto {
  id: string;
  sourceMessageId: string;
  sourceChannelId: string;
  starboardMessageId: string | null;
  authorId: string;
  starCount: number;
  createdAt: string;
}

export interface TempVoiceChannelDto {
  id: string;
  channelId: string;
  ownerId: string;
  hubChannelId: string;
  createdAt: string;
}
