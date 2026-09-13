// Pure/business logic for the `engagement` plugin: level math, the Redis-backed XP-award engine
// (message + voice), level-role reward computation, reputation cooldowns, starboard threshold
// decisions, and temp-voice helpers. Kept free of discord.js runtime types where possible so it's
// directly unit-testable (ARCHITECTURE.md §7.1 "service.ts — business logic ... this is what unit
// tests target").
import type Redis from 'ioredis';
import { redisKey } from '@pavisie/core';
import type { EngagementLevelingConfig, EngagementRewardMode } from './manifest';

// ---------------------------------------------------------------------------
// Level math — level(xp) via cumulative 5*l^2 + 50*l + 100 per level (ARCHITECTURE task spec).
// ---------------------------------------------------------------------------

/** XP required to go from level `l` to `l + 1`. */
export function xpToNextLevel(level: number): number {
  const l = Math.max(0, Math.floor(level));
  return 5 * l * l + 50 * l + 100;
}

/**
 * Total cumulative XP required to *reach* `level` (i.e. `xpForLevel(0) === 0`). Closed form of
 * `sum_{l=0}^{level-1} (5l^2 + 50l + 100)`.
 */
export function xpForLevel(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  const n = Math.floor(level);
  return (5 * (n - 1) * n * (2 * n - 1)) / 6 + 25 * n * (n - 1) + 100 * n;
}

/** Inverse of `xpForLevel`: the highest level whose cumulative XP requirement is `<= xp`. Monotonic, total for any finite non-negative `xp`. */
export function levelFromXp(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 0;

  let lo = 0;
  let hi = 1;
  while (xpForLevel(hi) <= xp) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (xpForLevel(mid) <= xp) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** XP earned so far within the user's current level, and the XP span of that level (for a progress bar). */
export function levelProgress(xp: number): { intoLevel: number; span: number; level: number } {
  const level = levelFromXp(xp);
  const floor = xpForLevel(level);
  const span = xpToNextLevel(level);
  return { intoLevel: Math.max(0, xp - floor), span, level };
}

/** Renders a `[width]`-character text progress bar (filled/empty blocks) for `current / total`. */
export function formatProgressBar(current: number, total: number, width = 20): string {
  const ratio = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

// ---------------------------------------------------------------------------
// Message XP engine (Redis-backed: per-user cooldown + rolling-hour cap).
// ---------------------------------------------------------------------------

/** Rolls a random integer XP amount in `[min, max]` (inclusive); tolerant of a swapped/equal min/max. */
export function rollMessageXp(min: number, max: number, rng: () => number = Math.random): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (hi <= lo) return Math.max(0, Math.floor(lo));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export interface XpAwardResult {
  awarded: boolean;
  xpGained: number;
  reason?: 'cooldown' | 'hourly_cap';
}

export type MessageXpConfig = Pick<
  EngagementLevelingConfig,
  'xpPerMessageMin' | 'xpPerMessageMax' | 'xpCooldownSeconds' | 'maxXpPerHour'
>;

/**
 * Attempts to award message XP to `userId` in `guildId`: enforces the per-user cooldown (Redis
 * `SET NX EX`) first, then a rolling-hour cap (Redis counter, TTL 3600s from first increment,
 * clamped so a roll never pushes the user over the cap). Never throws for "on cooldown"/"capped" —
 * those are reported via the result, not an exception, since they're expected steady-state outcomes.
 */
export async function tryAwardMessageXp(
  redis: Redis,
  guildId: string,
  userId: string,
  config: MessageXpConfig,
  rng: () => number = Math.random,
): Promise<XpAwardResult> {
  if (config.xpCooldownSeconds > 0) {
    const cooldownKey = redisKey('engagement', 'xpcooldown', guildId, userId);
    const acquired = await redis.set(cooldownKey, '1', 'EX', config.xpCooldownSeconds, 'NX');
    if (acquired !== 'OK') {
      return { awarded: false, xpGained: 0, reason: 'cooldown' };
    }
  }

  const hourKey = redisKey('engagement', 'xphour', guildId, userId);
  const rawCurrent = await redis.get(hourKey);
  const current = Number(rawCurrent ?? '0');
  if (current >= config.maxXpPerHour) {
    return { awarded: false, xpGained: 0, reason: 'hourly_cap' };
  }

  const rolled = rollMessageXp(config.xpPerMessageMin, config.xpPerMessageMax, rng);
  const grant = Math.max(0, Math.min(rolled, config.maxXpPerHour - current));
  if (grant <= 0) {
    return { awarded: false, xpGained: 0, reason: 'hourly_cap' };
  }

  await redis.incrby(hourKey, grant);
  if (rawCurrent === null) {
    await redis.expire(hourKey, 3600);
  }

  return { awarded: true, xpGained: grant };
}

// ---------------------------------------------------------------------------
// Voice XP engine (Redis-backed session timer per guild+user).
// ---------------------------------------------------------------------------

/** Minimal shape of a voice-connected guild member needed to decide voice-XP eligibility — no discord.js dependency. */
export interface VoiceMemberLike {
  id: string;
  isBot: boolean;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
}

/** A member counts toward voice XP if they're human and not muted/deafened (by themselves or the server). */
export function isEligibleVoiceMember(member: VoiceMemberLike): boolean {
  return !member.isBot && !member.selfMute && !member.selfDeaf && !member.serverMute && !member.serverDeaf;
}

/** A voice channel only earns XP for its occupants once at least 2 eligible (unmuted, human) members are present. */
export function channelQualifiesForVoiceXp(members: VoiceMemberLike[]): boolean {
  return members.filter(isEligibleVoiceMember).length >= 2;
}

function voiceSessionKey(guildId: string, userId: string): string {
  return redisKey('engagement', 'voicesession', guildId, userId);
}

/**
 * Upper bound on a single voice-XP session, in minutes (12h). A session is only settled by a
 * `voiceStateUpdate`, so a missed leave event (bot redeploy, gateway reconnect) would otherwise leave the
 * start timestamp in Redis forever and pay it all out days later. 12h is longer than any plausible
 * uninterrupted call — so a genuine marathon session is still credited in full — while capping what a
 * resurrected key can ever be worth. The TTL bounds how long a leaked key survives; the clamp bounds the
 * payout of one settled just under that TTL (and covers clock skew between the writer and the settler).
 */
export const MAX_VOICE_SESSION_MINUTES = 12 * 60;
export const MAX_VOICE_SESSION_SECONDS = MAX_VOICE_SESSION_MINUTES * 60;

/**
 * Starts (or restarts) a user's voice-XP session clock. Idempotent — calling it again just resets the start
 * time. The key expires after `MAX_VOICE_SESSION_SECONDS`; if it expires while the member is genuinely still
 * connected, the next `voiceStateUpdate` in that channel sees no session and starts a fresh one.
 */
export async function startVoiceSession(
  redis: Redis,
  guildId: string,
  userId: string,
  atMs = Date.now(),
): Promise<void> {
  await redis.set(voiceSessionKey(guildId, userId), String(atMs), 'EX', MAX_VOICE_SESSION_SECONDS);
}

/** True if `userId` currently has an open voice-XP session. */
export async function hasVoiceSession(redis: Redis, guildId: string, userId: string): Promise<boolean> {
  return (await redis.get(voiceSessionKey(guildId, userId))) !== null;
}

/**
 * Stops a user's voice-XP session (if any) and returns the whole minutes elapsed since it started, clamped
 * to `MAX_VOICE_SESSION_MINUTES`. Returns 0 (no-op) if the user had no open session.
 */
export async function stopVoiceSession(
  redis: Redis,
  guildId: string,
  userId: string,
  atMs = Date.now(),
): Promise<number> {
  const key = voiceSessionKey(guildId, userId);
  const raw = await redis.get(key);
  if (raw === null) return 0;
  await redis.del(key);
  const startedAt = Number(raw);
  if (!Number.isFinite(startedAt)) return 0;
  const elapsed = Math.max(0, Math.floor((atMs - startedAt) / 60_000));
  return Math.min(elapsed, MAX_VOICE_SESSION_MINUTES);
}

/** XP earned for `minutes` of qualifying voice presence at `xpPerMinute`. */
export function voiceXpForMinutes(minutes: number, xpPerMinute: number): number {
  return Math.max(0, Math.floor(minutes)) * Math.max(0, xpPerMinute);
}

// ---------------------------------------------------------------------------
// Level-role rewards (stack vs. replace).
// ---------------------------------------------------------------------------

export interface RewardDef {
  level: number;
  roleId: string;
}

export interface RewardPlan {
  toAdd: string[];
  toRemove: string[];
}

/**
 * Computes which level-reward roles a member should have at `atLevel`, given every reward defined
 * for the guild and the member's current roles. `'stack'` grants every reward at or below the
 * level (never removes). `'replace'` keeps only the single highest-level reward the member has
 * earned, removing any lower reward roles they're currently holding.
 */
export function computeLevelRewardPlan(
  currentRoleIds: string[],
  rewards: RewardDef[],
  atLevel: number,
  mode: EngagementRewardMode,
): RewardPlan {
  const applicable = rewards.filter((r) => r.level <= atLevel);

  if (mode === 'stack') {
    const toAdd = [...new Set(applicable.map((r) => r.roleId).filter((id) => !currentRoleIds.includes(id)))];
    return { toAdd, toRemove: [] };
  }

  if (applicable.length === 0) return { toAdd: [], toRemove: [] };

  const highest = applicable.reduce((best, r) => (r.level > best.level ? r : best));
  const allRewardRoleIds = new Set(rewards.map((r) => r.roleId));
  const toRemove = [
    ...new Set(currentRoleIds.filter((id) => allRewardRoleIds.has(id) && id !== highest.roleId)),
  ];
  const toAdd = currentRoleIds.includes(highest.roleId) ? [] : [highest.roleId];
  return { toAdd, toRemove };
}

// ---------------------------------------------------------------------------
// Reputation.
// ---------------------------------------------------------------------------

export type RepEligibility = { ok: true } | { ok: false; reason: 'self' };

/** A giver may never give reputation to themselves. */
export function canGiveRep(fromUserId: string, toUserId: string): RepEligibility {
  return fromUserId === toUserId ? { ok: false, reason: 'self' } : { ok: true };
}

export interface CooldownOutcome {
  ok: boolean;
  retryAfterMs: number;
}

function repCooldownKey(guildId: string, fromUserId: string): string {
  return redisKey('engagement', 'repcooldown', guildId, fromUserId);
}

/**
 * Takes the per-giver reputation cooldown (Redis `SET NX PX`). Because the cooldown is scoped to
 * the giver (not giver+target), one successful `take` also guarantees "at most one rep given to any
 * single target per day from the same giver" whenever `cooldownHours >= 24`.
 */
export async function takeRepCooldown(
  redis: Redis,
  guildId: string,
  fromUserId: string,
  cooldownHours: number,
): Promise<CooldownOutcome> {
  const key = repCooldownKey(guildId, fromUserId);
  const ttlMs = Math.max(1, cooldownHours) * 3_600_000;
  const acquired = await redis.set(key, '1', 'PX', ttlMs, 'NX');
  if (acquired === 'OK') return { ok: true, retryAfterMs: 0 };
  const ttl = await redis.pttl(key);
  return { ok: false, retryAfterMs: ttl > 0 ? ttl : ttlMs };
}

// ---------------------------------------------------------------------------
// Starboard.
// ---------------------------------------------------------------------------

export type StarboardAction = 'none' | 'post' | 'update' | 'remove';

/**
 * Decides what the starboard should do given the message's current eligible-reactor count vs. the
 * configured threshold and whether it's already posted. Crossing the threshold upward posts;
 * crossing back down below it after being posted removes; staying posted with a changed count
 * updates the embed's star count; anything else is a no-op.
 */
export function decideStarboardAction(
  isPosted: boolean,
  previousCount: number,
  newCount: number,
  threshold: number,
): StarboardAction {
  if (newCount < threshold) {
    return isPosted ? 'remove' : 'none';
  }
  if (!isPosted) return 'post';
  return newCount !== previousCount ? 'update' : 'none';
}

/** Counts distinct eligible reactors (bots already excluded by the caller), optionally excluding the message author. */
export function countEligibleReactors(
  reactorUserIds: string[],
  authorId: string,
  ignoreSelfStar: boolean,
): number {
  const set = new Set(reactorUserIds);
  if (ignoreSelfStar) set.delete(authorId);
  return set.size;
}

/** Discord's wire form for a custom emoji: `<:name:id>` / `<a:name:id>`. Emoji names are 2-32 word chars. */
export const CUSTOM_EMOJI_PATTERN = /^<a?:(\w{2,32}):(\d+)>$/;

/** A bare shortcode as typed into a text option (`:sparkle:`) — Discord does not substitute these itself. */
const SHORTCODE_PATTERN = /^:(\w{2,32}):$/;

// Built via `new RegExp` rather than a literal so the unicode property escapes don't depend on the
// TypeScript target. One "element" is a pictograph (optionally skin-toned, VS16'd or tag-sequenced), a
// two-character regional-indicator flag, or a keycap; a full emoji is one or more elements joined by ZWJ.
const EMOJI_ELEMENT =
  '(?:\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3|\\p{Extended_Pictographic}(?:\\p{Emoji_Modifier}|\\uFE0F)?[\\u{E0020}-\\u{E007F}]*)';
const UNICODE_EMOJI_PATTERN = new RegExp(`^${EMOJI_ELEMENT}(?:\\u200D${EMOJI_ELEMENT})*$`, 'u');

/** The subset of a discord.js `GuildEmoji` this module needs, so `service.ts` stays discord.js-free. */
export interface GuildEmojiLike {
  id: string;
  name: string | null;
  animated: boolean | null;
}

export type EmojiResolution =
  | { ok: true; emoji: string }
  | { ok: false; reason: 'empty' | 'invalid' }
  | { ok: false; reason: 'unknown_custom'; name: string };

/**
 * Validates a user-typed starboard emoji and normalises it into a form `emojiMatches` can actually match:
 * a unicode emoji is kept as-is, `<a?:name:id>` is kept as-is, and a bare `:name:` shortcode is resolved
 * against the guild's own emoji (Discord delivers slash-command string options verbatim, so a shortcode
 * would otherwise be stored as a string that no reaction can ever equal).
 */
export function resolveStarboardEmoji(
  raw: string,
  findGuildEmojiByName: (name: string) => GuildEmojiLike | null = () => null,
): EmojiResolution {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: 'empty' };
  if (CUSTOM_EMOJI_PATTERN.test(value)) return { ok: true, emoji: value };
  if (UNICODE_EMOJI_PATTERN.test(value)) return { ok: true, emoji: value };

  const shortcode = SHORTCODE_PATTERN.exec(value);
  if (shortcode) {
    const name = shortcode[1]!;
    const found = findGuildEmojiByName(name);
    if (!found) return { ok: false, reason: 'unknown_custom', name };
    return { ok: true, emoji: `<${found.animated ? 'a' : ''}:${found.name ?? name}:${found.id}>` };
  }

  return { ok: false, reason: 'invalid' };
}

// ---------------------------------------------------------------------------
// Temporary voice channels.
// ---------------------------------------------------------------------------

const TEMP_VOICE_NAME_MAX = 100; // Discord channel name limit.

/** Renders a temp-voice channel name template (`{user}` placeholder), truncated to Discord's channel-name limit. */
export function renderTempVoiceName(template: string, vars: { user: string }): string {
  const rendered = template.replace(/\{user\}/g, vars.user).trim();
  const safe = rendered.length > 0 ? rendered : `${vars.user}'s channel`;
  return safe.length > TEMP_VOICE_NAME_MAX ? safe.slice(0, TEMP_VOICE_NAME_MAX) : safe;
}

/** A temp-voice channel with no members left is an orphan and should be torn down. */
export function isOrphanTempVoiceChannel(memberCount: number): boolean {
  return memberCount <= 0;
}
