import type { Client, Guild, GuildBasedChannel } from 'discord.js';
import type { Logger } from 'pino';
import type { GuildConfigStore } from './config-store';
import { classifyDiscordFailure } from './discord-errors';

/** Default gap between mod-log notices for the same guild and action. */
export const PERMISSION_NOTICE_WINDOW_MS = 60 * 60 * 1000;

const ACTION_LABEL_MAX = 80;
const MAX_PERMISSION_NOTICES = 1024;

const DEBUG_SUPPRESSED = 'missing-permissions notice suppressed';
const DEBUG_NO_MOD_LOG = 'missing-permissions notice skipped; no mod-log channel configured';
const DEBUG_NO_GUILD = 'missing-permissions notice skipped; guild unavailable';
const DEBUG_NO_CHANNEL = 'missing-permissions notice skipped; mod-log channel unavailable';
const DEBUG_POST_FAILED = 'missing-permissions notice skipped; posting failed';
const DEBUG_CONFIG_FAILED = 'missing-permissions notice skipped; guild config unavailable';
const DEBUG_SKIPPED = 'missing-permissions notice skipped';

interface NoticeStamp {
  at: number;
  windowMs: number;
}

/**
 * Last time a notice was posted, keyed by guild id and sanitized action. In-process only: a restart may
 * post again, and the map drops expired entries and the oldest keys once it passes {@link MAX_PERMISSION_NOTICES}.
 */
const notices = new Map<string, NoticeStamp>();

export interface NotifyMissingPermissionsInput {
  /** Used to resolve `guildId` when `guild` is omitted. */
  client?: Client;
  /** Already-resolved guild. Preferred over `client` when its id matches `guildId`. */
  guild?: Guild;
  guildId: string;
  /** Short description of the action that failed. Sanitized before it is posted. */
  action: string;
  configStore: Pick<GuildConfigStore, 'getGuildConfig'>;
  logger?: Pick<Logger, 'debug'>;
  /**
   * Minimum gap between notices for one guild and action. Defaults to {@link PERMISSION_NOTICE_WINDOW_MS}.
   * Tests pass a shorter window.
   */
  windowMs?: number;
}

/** True when `err` is a Discord REST 50013 (Missing Permissions). */
export function isMissingPermissions(err: unknown): boolean {
  return classifyDiscordFailure(err) === 'missing_permissions';
}

function debug(logger: Pick<Logger, 'debug'> | undefined, message: string): void {
  logger?.debug(message);
}

function resolveWindow(windowMs: number | undefined): number {
  if (windowMs === undefined || !Number.isFinite(windowMs) || windowMs < 0)
    return PERMISSION_NOTICE_WINDOW_MS;
  return windowMs;
}

function sanitizeAction(action: string, tokens: readonly string[]): string {
  const firstLine = action.split(/\r?\n/, 1)[0] ?? '';
  let cleaned = firstLine.replace(/\d{17,20}/g, ' ');
  for (const token of tokens) {
    if (token.length >= 6 && cleaned.includes(token)) cleaned = cleaned.split(token).join(' ');
  }
  cleaned = cleaned
    .replace(/[^\p{L}\p{N}\s'./-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ACTION_LABEL_MAX)
    .trim();
  return cleaned.length > 0 ? cleaned : 'that action';
}

function noticeKey(guildId: string, action: string): string {
  return `${guildId}\u0000${action}`;
}

function pruneNotices(now: number): void {
  for (const [key, stamp] of notices) {
    if (now - stamp.at >= stamp.windowMs) notices.delete(key);
  }
  while (notices.size > MAX_PERMISSION_NOTICES) {
    const oldest = notices.keys().next().value;
    if (oldest === undefined) break;
    notices.delete(oldest);
  }
}

function isSuppressed(key: string, now: number): boolean {
  pruneNotices(now);
  const stamp = notices.get(key);
  return stamp !== undefined && now - stamp.at < stamp.windowMs;
}

function remember(key: string, now: number, windowMs: number): void {
  notices.delete(key);
  notices.set(key, { at: now, windowMs });
  pruneNotices(now);
}

async function resolveGuild(input: NotifyMissingPermissionsInput): Promise<Guild | null> {
  if (input.guild && input.guild.id === input.guildId) return input.guild;
  if (!input.client) return null;
  const cached = input.client.guilds.cache.get(input.guildId);
  if (cached) return cached;
  try {
    return (await input.client.guilds.fetch(input.guildId)) ?? null;
  } catch {
    return null;
  }
}

function canSend(
  channel: GuildBasedChannel | null,
): channel is GuildBasedChannel & { send: (content: string) => Promise<unknown> } {
  return Boolean(channel && channel.isTextBased() && !channel.isDMBased());
}

/**
 * Posts one generic English line to the guild's core mod-log channel (`GuildConfig.modLogChannelId`) when a
 * caller caught a missing-permissions failure. The notice names only the sanitized action — no ids, raw
 * Discord error text, or stack traces.
 *
 * At most one notice is sent per guild and action per window (one hour unless `windowMs` is set). The limit
 * lives in memory. The function never throws: a missing mod-log channel, a failed fetch, or a failed send
 * (including 50013 on the mod-log channel itself) is a debug log and nothing else.
 *
 * ```ts
 * if (isMissingPermissions(err)) await notifyMissingPermissions({ client, guildId, action, configStore, logger });
 * ```
 */
export async function notifyMissingPermissions(input: NotifyMissingPermissionsInput): Promise<void> {
  try {
    await postNotice(input);
  } catch {
    debug(input.logger, DEBUG_SKIPPED);
  }
}

async function postNotice(input: NotifyMissingPermissionsInput): Promise<void> {
  if (typeof input.guildId !== 'string' || input.guildId.length === 0) {
    debug(input.logger, DEBUG_NO_GUILD);
    return;
  }

  let modLogChannelId: string | null;
  try {
    const config = await input.configStore.getGuildConfig(input.guildId);
    modLogChannelId = config.modLogChannelId;
  } catch {
    debug(input.logger, DEBUG_CONFIG_FAILED);
    return;
  }

  if (!modLogChannelId) {
    debug(input.logger, DEBUG_NO_MOD_LOG);
    return;
  }

  const action = sanitizeAction(typeof input.action === 'string' ? input.action : '', [
    input.guildId,
    modLogChannelId,
  ]);
  const windowMs = resolveWindow(input.windowMs);
  const now = Date.now();
  const key = noticeKey(input.guildId, action);
  if (isSuppressed(key, now)) {
    debug(input.logger, DEBUG_SUPPRESSED);
    return;
  }

  const guild = await resolveGuild(input);
  if (!guild) {
    debug(input.logger, DEBUG_NO_GUILD);
    return;
  }

  let channel: GuildBasedChannel | null;
  try {
    channel = await guild.channels.fetch(modLogChannelId);
  } catch {
    debug(input.logger, DEBUG_NO_CHANNEL);
    return;
  }
  if (!canSend(channel)) {
    debug(input.logger, DEBUG_NO_CHANNEL);
    return;
  }

  const content = `Pavisie is missing a Discord permission it needs for ${action}. Check the bot role's permissions and channel overrides.`;
  remember(key, now, windowMs);
  try {
    await channel.send(content);
  } catch {
    debug(input.logger, DEBUG_POST_FAILED);
  }
}
