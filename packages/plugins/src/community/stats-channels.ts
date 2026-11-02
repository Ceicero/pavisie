import { DateTime } from 'luxon';
import type { Guild } from 'discord.js';

/** Aggregate server counts a stats-channel template can render. Nothing per member — see manifest privacyNotes. */
export interface GuildCounts {
  members: number;
  humans: number;
  bots: number;
  boosts: number;
  roles: number;
  channels: number;
  /** YYYY-MM-DD in the guild's timezone. */
  date: string;
}

/** The fixed set of `{token}` names a template may use. `{online}` is deliberately absent (needs the Presence intent). */
export const STATS_TOKENS = ['members', 'humans', 'bots', 'boosts', 'roles', 'channels', 'date'] as const;
export type StatsToken = (typeof STATS_TOKENS)[number];

/** Discord's hard limit on channel names. */
export const CHANNEL_NAME_MAX = 100;

/** Discord allows 2 channel-name edits per 10 minutes per channel; we keep 1 per 5 minutes so manual + periodic refreshes fit. */
export const RENAME_BUDGET_MS = 5 * 60_000;

/** Minimum gap between two renames of the SAME channel (periodic or manual) — half of Discord's 2-per-10-minutes budget. */
export const CHANNEL_RENAME_INTERVAL_MS = 10 * 60_000;

const TOKEN_PATTERN = /\{([a-zA-Z_]+)\}/g;

function isStatsToken(name: string): name is StatsToken {
  return (STATS_TOKENS as readonly string[]).includes(name);
}

/** Renders `template` with `counts`. Unknown `{tokens}` are left literal; the result is truncated to Discord's 100-char channel-name limit. */
export function renderStatsName(template: string, counts: GuildCounts): string {
  const rendered = template.replace(TOKEN_PATTERN, (match, name: string) =>
    isStatsToken(name) ? String(counts[name]) : match,
  );
  return rendered.slice(0, CHANNEL_NAME_MAX);
}

export interface TemplateCheck {
  ok: boolean;
  /** Unknown token names (without braces), in order of first appearance, de-duplicated. */
  unknown: string[];
  /** True when the template asks for `{online}` — rejected with a specific explanation (Presence intent). */
  wantsOnline: boolean;
}

/** Validates the `{tokens}` in `template` against `STATS_TOKENS` so typos never become a channel literally named "{memebrs}". */
export function checkTemplateTokens(template: string): TemplateCheck {
  const unknown: string[] = [];
  let wantsOnline = false;
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    const name = match[1] ?? '';
    if (isStatsToken(name)) continue;
    if (name.toLowerCase() === 'online') {
      wantsOnline = true;
      continue;
    }
    if (!unknown.includes(name)) unknown.push(name);
  }
  return { ok: unknown.length === 0 && !wantsOnline, unknown, wantsOnline };
}

export interface CollectCountsOptions {
  /** Whether the GuildMembers privileged intent is enabled (`ctx.intentsEnabled.guildMembers`). Without it the member cache is partial, so humans = members and bots = 0. */
  guildMembersIntent: boolean;
  now?: Date;
}

/**
 * Collects the aggregate counts for `guild`. `members` is `guild.memberCount` (always accurate);
 * `humans`/`bots` come from the member cache only when the GuildMembers intent is on — otherwise the
 * split is unavailable and `humans = members`, `bots = 0` (callers should note the limitation).
 */
export function collectCounts(guild: Guild, tz: string, opts: CollectCountsOptions): GuildCounts {
  const members = guild.memberCount;
  let humans = members;
  let bots = 0;
  if (opts.guildMembersIntent) {
    bots = guild.members.cache.filter((m) => m.user.bot).size;
    humans = Math.max(0, members - bots);
  }
  const boosts = guild.premiumSubscriptionCount ?? 0;
  // `roles.cache` always contains `@everyone`, which nobody counts as a role.
  const roles = Math.max(0, guild.roles.cache.size - 1);
  const channels = guild.channels.cache.size;
  const nowDt = DateTime.fromJSDate(opts.now ?? new Date()).setZone(tz);
  const date = (
    nowDt.isValid ? nowDt : DateTime.fromJSDate(opts.now ?? new Date(), { zone: 'utc' })
  ).toFormat('yyyy-LL-dd');
  return { members, humans, bots, boosts, roles, channels, date };
}

/** Earliest time another rename is allowed after `lastRenamedAt` (one per `RENAME_BUDGET_MS`); `now` when there was no previous rename. */
export function nextRefreshAllowedAt(lastRenamedAt: Date | null, now = new Date()): Date {
  if (!lastRenamedAt) return now;
  return new Date(lastRenamedAt.getTime() + RENAME_BUDGET_MS);
}
