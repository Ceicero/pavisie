import { ChannelType } from 'discord.js';
import { redisKey, truncate } from '@pavisie/core';
import type { AutoPublishConfig, AutoThreadRule } from './manifest';

/** Discord's hard limit on thread names. */
export const THREAD_NAME_MAX = 100;
/** Discord auto-archive durations (minutes) accepted by `startThread`. */
export const ARCHIVE_MINUTES = [60, 1440, 4320, 10080] as const;
export type ArchiveMinutes = (typeof ARCHIVE_MINUTES)[number];
/** Max entries for both `autoPublish.channelIds` and `autoThreads` (mirrors the zod schema). */
export const CHANNEL_AUTOMATION_MAX = 25;

/** Warn-once TTL for per-channel failure logs (auto-publish + auto-thread). */
export const WARN_TTL_SECONDS = 3600;
/** TTL for the per-day auto-publish counter (2 days so "today" survives a UTC rollover). */
export const COUNTER_TTL_SECONDS = 172_800;
/** Discord allows at most 10 published (crossposted) messages per hour per announcement channel. */
export const AUTO_PUBLISH_HOURLY_LIMIT = 10;
/** TTL for the per-channel hourly auto-publish budget counter — resets an hour after the first crosspost in a window. */
export const AUTO_PUBLISH_BUDGET_TTL_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Redis keys (shared by the bot handler and the API stats endpoint)
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` in UTC — the day bucket used by the auto-publish counter on both the bot and API side. */
export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function autoPublishCountKey(guildId: string, day: string = utcDayKey()): string {
  return redisKey('community', 'autopublish-count', guildId, day);
}

export function autoPublishWarnedKey(channelId: string): string {
  return redisKey('community', 'autopublish-warned', channelId);
}

/** Per-channel hourly crosspost budget counter (`INCR` with `EX 3600` on first increment) — Discord's 10/hour
 * crosspost limit isn't reported as a normal rejection (discord.js sleeps through a 429 instead of throwing), so
 * this is enforced proactively rather than by reacting to an API error. */
export function autoPublishBudgetKey(channelId: string): string {
  return redisKey('community', 'autopublish-budget', channelId);
}

export function autoThreadWarnedKey(channelId: string): string {
  return redisKey('community', 'autothread-warned', channelId);
}

// ---------------------------------------------------------------------------
// Auto-publish
// ---------------------------------------------------------------------------

export interface AutoPublishCandidate {
  channelId: string;
  /** discord.js `ChannelType` numeric value of the message's channel. */
  channelType: number;
  authorIsBot: boolean;
  authorId: string;
  botUserId: string;
  /** True if the message already carries the `Crossposted` (or `IsCrosspost`) flag. */
  flagsCrossposted: boolean;
}

/**
 * True when a new message should be crossposted: it lives in an announcement channel the guild listed, isn't
 * already published, and its author is a human, this bot, or (only when `includeBots`) some other bot/webhook.
 * Never looks at message content.
 */
export function shouldAutoPublish(m: AutoPublishCandidate, cfg: AutoPublishConfig): boolean {
  if (m.channelType !== ChannelType.GuildAnnouncement) return false;
  if (!cfg.channelIds.includes(m.channelId)) return false;
  if (m.flagsCrossposted) return false;
  if (!m.authorIsBot) return true;
  return cfg.includeBots || m.authorId === m.botUserId;
}

// ---------------------------------------------------------------------------
// Auto-threads
// ---------------------------------------------------------------------------

export function findAutoThreadRule(
  channelId: string,
  rules: readonly AutoThreadRule[],
): AutoThreadRule | undefined {
  return rules.find((rule) => rule.channelId === channelId);
}

export interface ThreadTemplateVars {
  user: string;
  'user.tag': string;
  server: string;
  /** `YYYY-MM-DD`. */
  date: string;
}

const TEMPLATE_TOKEN_PATTERN = /\{([a-zA-Z._]+)\}/g;

/**
 * Substitutes `{user}`, `{user.tag}`, `{server}`, `{date}` in `template`. Unknown tokens are left literal (never
 * evaluated), matching `roles/engine.ts`'s `renderTemplate` semantics — the output is always plain text derived
 * from the fixed variable set, with no recursive re-substitution.
 */
export function renderTemplate(template: string, vars: ThreadTemplateVars): string {
  return template.replace(TEMPLATE_TOKEN_PATTERN, (whole, token: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, token)) {
      return String(vars[token as keyof ThreadTemplateVars]);
    }
    return whole;
  });
}

/** Renders a thread-name template and clamps it to Discord's 100-char limit (never returns an empty name). */
export function renderThreadName(template: string, vars: ThreadTemplateVars): string {
  const rendered = truncate(renderTemplate(template, vars), THREAD_NAME_MAX).trim();
  return rendered.length > 0 ? rendered : 'Thread';
}

export interface AutoThreadCandidate {
  hasAttachmentOrEmbed: boolean;
  authorIsBot: boolean;
  /** True if the message already has a thread (e.g. another bot or a member started one first). */
  isThreadStarterAlready: boolean;
}

/** True when a message in an auto-thread channel should get its own thread: bots are always skipped, as are messages that already have a thread; `requireAttachment` skips text-only posts. */
export function shouldAutoThread(m: AutoThreadCandidate, rule: AutoThreadRule): boolean {
  if (m.authorIsBot) return false;
  if (m.isThreadStarterAlready) return false;
  if (rule.requireAttachment && !m.hasAttachmentOrEmbed) return false;
  return true;
}

/** True for the Discord API "you are being rate limited" / crosspost-limit family of errors (10 crossposts per hour per channel). */
export function isCrosspostLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: unknown; message?: unknown; name?: unknown };
  if (e.status === 429 || e.name === 'RateLimitError') return true;
  return typeof e.message === 'string' && /crosspost|rate limit/i.test(e.message);
}

/** True for Discord API error 50013 (Missing Permissions). */
export function isMissingPermissionsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 50013 || code === '50013';
}
