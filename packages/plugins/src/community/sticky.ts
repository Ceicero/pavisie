// Sticky messages: one staff-authored message the bot keeps at the bottom of a channel by deleting its own
// previous copy and re-posting whenever members post — rate-limited per channel with a Redis cooldown and a
// single debounced BullMQ catch-up job so a busy channel never gets spammed. No member message content is ever
// read; the messageCreate handler only reacts to "a message was posted".
import {
  DiscordAPIError,
  EmbedBuilder,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Guild,
  type GuildTextBasedChannel,
} from 'discord.js';
import { Prisma, type StickyMessage } from '@pavisie/database';
import { AuditAction, EMBED_LIMITS, sanitizeEmbedText, truncate } from '@pavisie/core';
import { resolveTextChannel, type PluginContext } from '../sdk';
import type { CommunityConfig } from './manifest';
import {
  STICKY_CHANNELS_TTL_SECONDS,
  STICKY_OWN_MESSAGE_TTL_SECONDS,
  STICKY_REPOST_LOCK_TTL_SECONDS,
  STICKY_SEND_WARN_TTL_SECONDS,
  isStickyEmbedEmpty,
  parseStickyEmbed,
  stickyChannelsKey,
  stickyCooldownKey,
  stickyOwnMessageKey,
  stickyRepostJobId,
  stickyRepostLockKey,
  stickySendWarnedKey,
  type StickyEmbed,
} from './sticky-keys';

export {
  STICKY_CHANNELS_TTL_SECONDS,
  stickyChannelsKey,
  stickyCooldownKey,
  stickyOwnMessageKey,
  stickyRepostJobId,
};
export type { StickyEmbed };

export const STICKY_CONTENT_MAX = 2000;

export type StickyErrorCode =
  | 'empty'
  | 'limit'
  | 'badChannel'
  | 'notFound'
  | 'missingEmbedPermission'
  | 'autoPublishConflict';

/** Thrown by the sticky service for user-facing failures; commands map `code` to a `sticky.<code>` locale key. */
export class StickyError extends Error {
  constructor(
    readonly code: StickyErrorCode,
    readonly vars: Record<string, string | number> = {},
  ) {
    super(`sticky:${code}`);
    this.name = 'StickyError';
  }
}

export interface UpsertStickyInput {
  guild: Guild;
  guildId: string;
  channelId: string;
  content?: string | null;
  embed?: StickyEmbed | null;
  cooldownSeconds: number;
  actorId: string;
}

export interface StickyRepostJobData {
  guildId: string;
  channelId: string;
}

// ---------------------------------------------------------------------------
// Cache + cooldown
// ---------------------------------------------------------------------------

/** Drops the cached "channels with a sticky" set for `guildId` (call after every DB write). */
export async function invalidateStickyChannels(ctx: PluginContext, guildId: string): Promise<void> {
  await ctx.redis.del(stickyChannelsKey(guildId));
}

/** Channel ids that have a sticky in `guildId`, from Redis when cached, else loaded from Postgres and cached for 5 minutes. */
export async function getStickyChannelIds(ctx: PluginContext, guildId: string): Promise<string[]> {
  const key = stickyChannelsKey(guildId);
  const cached = await ctx.redis.get(key);
  if (cached !== null) {
    try {
      const parsed = JSON.parse(cached) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      // fall through and rebuild
    }
  }
  const rows = await ctx.prisma.stickyMessage.findMany({ where: { guildId }, select: { channelId: true } });
  const ids = rows.map((r) => r.channelId);
  await ctx.redis.set(key, JSON.stringify(ids), 'EX', STICKY_CHANNELS_TTL_SECONDS);
  return ids;
}

/** Takes the per-channel re-post cooldown; `true` when this call won it (nothing else re-posted within `cooldownSeconds`). */
export async function tryAcquireStickyCooldown(
  ctx: PluginContext,
  guildId: string,
  channelId: string,
  cooldownSeconds: number,
): Promise<boolean> {
  const result = await ctx.redis.set(
    stickyCooldownKey(guildId, channelId),
    '1',
    'EX',
    Math.max(1, cooldownSeconds),
    'NX',
  );
  return result === 'OK';
}

/**
 * Schedules the single catch-up re-post for a channel whose cooldown blocked an immediate one. The fixed
 * `jobId` makes a second call while one is already pending a no-op — exactly the debounce we want — so a burst
 * of N messages produces one re-post now and one more once the cooldown lapses.
 */
export async function scheduleStickyCatchUp(
  ctx: PluginContext,
  guildId: string,
  channelId: string,
  cooldownSeconds: number,
): Promise<void> {
  await ctx
    .queue('sticky-repost')
    .add('sticky-repost', { guildId, channelId } satisfies StickyRepostJobData, {
      jobId: stickyRepostJobId(guildId, channelId),
      delay: Math.max(1, cooldownSeconds) * 1000,
      removeOnComplete: true,
      removeOnFail: true,
    });
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

const HEX_COLOR_PATTERN = /^#?[0-9a-fA-F]{6}$/;

function buildStickyEmbed(embed: StickyEmbed): EmbedBuilder {
  const builder = new EmbedBuilder();
  if (embed.title) builder.setTitle(truncate(embed.title, EMBED_LIMITS.title));
  if (embed.description) builder.setDescription(truncate(embed.description, EMBED_LIMITS.description));
  if (embed.footer) builder.setFooter({ text: truncate(embed.footer, EMBED_LIMITS.footer) });
  if (embed.imageUrl) builder.setImage(embed.imageUrl);
  if (embed.colorHex && HEX_COLOR_PATTERN.test(embed.colorHex.trim())) {
    builder.setColor(parseInt(embed.colorHex.trim().replace(/^#/, ''), 16));
  }
  return builder;
}

/** The message payload the bot posts for a sticky. Mentions are always suppressed — a sticky must never ping anyone on every re-post. */
export function stickyPayload(sticky: Pick<StickyMessage, 'content' | 'embed'>): {
  content?: string;
  embeds?: EmbedBuilder[];
  allowedMentions: { parse: [] };
} {
  const embed = parseStickyEmbed(sticky.embed);
  const content = sticky.content?.trim() ? truncate(sticky.content, STICKY_CONTENT_MAX) : undefined;
  return {
    ...(content ? { content } : {}),
    ...(embed ? { embeds: [buildStickyEmbed(embed)] } : {}),
    allowedMentions: { parse: [] },
  };
}

// ---------------------------------------------------------------------------
// Re-posting
// ---------------------------------------------------------------------------

function isDiscordError(err: unknown, code: number): boolean {
  return err instanceof DiscordAPIError && err.code === code;
}

/** True when Discord reports the channel no longer exists (as opposed to "not visible / no permission right now"). */
async function channelIsGone(guild: Guild, channelId: string): Promise<boolean> {
  try {
    const channel = await guild.channels.fetch(channelId);
    return channel === null;
  } catch (err) {
    return isDiscordError(err, RESTJSONErrorCodes.UnknownChannel);
  }
}

async function pruneSticky(ctx: PluginContext, sticky: StickyMessage): Promise<void> {
  await ctx.prisma.stickyMessage.deleteMany({ where: { id: sticky.id } });
  await invalidateStickyChannels(ctx, sticky.guildId);
  ctx.logger.info(
    { guildId: sticky.guildId, channelId: sticky.channelId },
    'community: sticky channel no longer exists; removed the sticky',
  );
}

async function deleteOwnMessage(channel: GuildTextBasedChannel, messageId: string): Promise<void> {
  try {
    await channel.messages.delete(messageId);
  } catch {
    // Unknown Message (already deleted by staff) is the expected failure; anything else (e.g. missing
    // Manage Messages after a channel overwrite change) is also non-fatal — the new copy still gets posted.
  }
}

/** Logs a sticky-send failure at most once per channel per hour (adapted from channel-automations.ts's `reportOnce`). */
async function reportStickySendFailure(
  ctx: PluginContext,
  guildId: string,
  channelId: string,
  description: string,
): Promise<void> {
  const key = stickySendWarnedKey(guildId, channelId);
  const first = await ctx.redis.set(key, '1', 'EX', STICKY_SEND_WARN_TTL_SECONDS, 'NX');
  if (first !== 'OK') return;
  ctx.logger.warn({ guildId, channelId, description }, 'community: sticky re-post failed to send');
  const logging = ctx.services.get('logging');
  if (logging) {
    try {
      await logging.log(guildId, 'bot.error', { channelId, title: 'Sticky message failed', description });
    } catch {
      // Logging is best-effort; never let it break the repost flow.
    }
  }
}

/** True when the bot can attach embeds in `channel` (View Channel + Send Messages are already required by `resolveTextChannel`). */
function channelHasEmbedLinks(guild: Guild, channel: GuildTextBasedChannel): boolean {
  const botMember = guild.members.me;
  if (!botMember) return false;
  const perms = channel.permissionsFor(botMember);
  return Boolean(perms?.has(PermissionFlagsBits.EmbedLinks));
}

/**
 * The actual delete-old + send-new + update-DB sequence, run only while the caller holds the per-channel
 * repost lock (`stickyRepostLockKey`). Never throws on a Discord send failure — it logs (once/hour/channel) and
 * resolves `null` instead, so a channel that starts rejecting the bot doesn't spam `plugin.error` on every message.
 */
async function repostStickyLocked(
  ctx: PluginContext,
  guild: Guild,
  sticky: StickyMessage,
): Promise<StickyMessage | null> {
  const channel = await resolveTextChannel(guild, sticky.channelId);
  if (!channel) {
    if (await channelIsGone(guild, sticky.channelId)) await pruneSticky(ctx, sticky);
    return null;
  }

  const embed = parseStickyEmbed(sticky.embed);
  if (embed && !channelHasEmbedLinks(guild, channel)) {
    await reportStickySendFailure(
      ctx,
      sticky.guildId,
      sticky.channelId,
      `I need the Embed Links permission in <#${sticky.channelId}> to post this sticky's embed; the old copy was left in place.`,
    );
    return null;
  }

  if (sticky.lastMessageId) await deleteOwnMessage(channel, sticky.lastMessageId);

  let posted;
  try {
    posted = await channel.send(stickyPayload(sticky));
  } catch (err) {
    await reportStickySendFailure(
      ctx,
      sticky.guildId,
      sticky.channelId,
      `Posting the sticky in <#${sticky.channelId}> failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  // Mark this as our own sticky repost so the auto-publish handler never crossposts it, even in a channel that
  // also has auto-publish enabled (`/sticky set` refuses that combination going forward, but existing setups
  // predating that check — or a config change after the fact — still need this safety net).
  await ctx.redis.set(stickyOwnMessageKey(posted.id), '1', 'EX', STICKY_OWN_MESSAGE_TTL_SECONDS);

  return ctx.prisma.stickyMessage.update({
    where: { id: sticky.id },
    data: { lastMessageId: posted.id, lastPostedAt: new Date() },
  });
}

/**
 * Deletes the bot's previous copy of `sticky` (if any) and posts a fresh one at the bottom of the channel,
 * recording the new message id/time. Serialized per channel via a short Redis lock (`SET NX EX`) so a
 * cooldown-triggered repost and the debounced catch-up job can never run the delete+send+update sequence
 * concurrently — without it, both can post a new copy and only one gets tracked, orphaning the other. Resolves
 * `null` when nothing was posted: another repost is already in flight (lock busy), the channel is unreachable
 * (pruned from the DB when Discord says it's gone), or the send itself failed (logged, not thrown).
 */
export async function repostSticky(
  ctx: PluginContext,
  guild: Guild,
  sticky: StickyMessage,
): Promise<StickyMessage | null> {
  const lockKey = stickyRepostLockKey(sticky.guildId, sticky.channelId);
  const acquired = await ctx.redis.set(lockKey, '1', 'EX', STICKY_REPOST_LOCK_TTL_SECONDS, 'NX');
  if (acquired !== 'OK') return null;
  try {
    return await repostStickyLocked(ctx, guild, sticky);
  } finally {
    await ctx.redis.del(lockKey);
  }
}

/**
 * Catch-up path run by the `sticky-repost` job after a cooldown-blocked burst: re-posts unless the sticky is
 * already the newest message in the channel, then re-arms the cooldown so the very next member message doesn't
 * trigger yet another immediate re-post. Acquires the same per-channel repost lock as `repostSticky` itself
 * (skipping entirely if another repost currently holds it) and, once inside the lock, re-fetches the sticky row
 * and re-checks freshness — the row this job started with may have gone stale while it sat in the queue, and
 * acting on it unconditionally is exactly how a concurrent repost's freshly-posted copy gets orphaned.
 */
export async function runStickyCatchUp(
  ctx: PluginContext,
  guildId: string,
  channelId: string,
): Promise<void> {
  const sticky = await ctx.prisma.stickyMessage.findUnique({
    where: { guildId_channelId: { guildId, channelId } },
  });
  if (!sticky) return;

  const config = await ctx.getConfig<CommunityConfig>(guildId);
  if (!config.sticky.enabled) return;

  const guild = await ctx.client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const lockKey = stickyRepostLockKey(guildId, channelId);
  const acquired = await ctx.redis.set(lockKey, '1', 'EX', STICKY_REPOST_LOCK_TTL_SECONDS, 'NX');
  if (acquired !== 'OK') return; // a repost is already in flight; it will leave the sticky at the bottom.

  try {
    // Re-read now that we hold the lock: a concurrent repost may have already moved the sticky (and armed the
    // cooldown) since this job was queued, in which case re-posting again would orphan that fresher copy.
    const fresh = await ctx.prisma.stickyMessage.findUnique({ where: { guildId_channelId: { guildId, channelId } } });
    if (!fresh) return;

    const channel = await resolveTextChannel(guild, channelId);
    if (channel && fresh.lastMessageId && channel.lastMessageId === fresh.lastMessageId) return;

    await repostStickyLocked(ctx, guild, fresh);
    await ctx.redis.set(stickyCooldownKey(guildId, channelId), '1', 'EX', Math.max(1, fresh.cooldownSeconds));
  } finally {
    await ctx.redis.del(lockKey);
  }
}

// ---------------------------------------------------------------------------
// Staff actions
// ---------------------------------------------------------------------------

function normalizeContent(content: string | null | undefined): string | null {
  const trimmed = content?.trim();
  if (!trimmed) return null;
  return truncate(trimmed, STICKY_CONTENT_MAX);
}

function normalizeEmbed(embed: StickyEmbed | null | undefined): StickyEmbed | null {
  if (!embed) return null;
  const clean = (value: string | undefined, max: number): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? sanitizeEmbedText(trimmed, max) : undefined;
  };
  const normalized: StickyEmbed = {
    title: clean(embed.title, EMBED_LIMITS.title),
    description: clean(embed.description, EMBED_LIMITS.description),
    footer: clean(embed.footer, EMBED_LIMITS.footer),
    imageUrl: embed.imageUrl?.trim() || undefined,
    colorHex:
      embed.colorHex && HEX_COLOR_PATTERN.test(embed.colorHex.trim()) ? embed.colorHex.trim() : undefined,
  };
  return isStickyEmbedEmpty(normalized) ? null : normalized;
}

/**
 * Creates or replaces the sticky for a channel, enforces `sticky.maxPerGuild` and "content or embed required",
 * posts it immediately, and writes an audit row. Throws `StickyError` for user-facing failures.
 */
export async function upsertSticky(ctx: PluginContext, input: UpsertStickyInput): Promise<StickyMessage> {
  const content = normalizeContent(input.content);
  const embed = normalizeEmbed(input.embed);
  if (!content && !embed) throw new StickyError('empty');

  const config = await ctx.getConfig<CommunityConfig>(input.guildId);

  // A sticky in an auto-publish channel would get crossposted on every single re-post — refuse the combination
  // up front rather than let it slip through. (`repostStickyLocked` also self-marks its own posts as a runtime
  // safety net for channels that had both enabled before this check existed, or gained auto-publish afterward.)
  // `config.autoPublish` defaults via the zod schema at runtime, but guard defensively (matches
  // `events/channel-automations.ts`'s `cfg.autoPublish ?? { channelIds: [], includeBots: false }`) since callers
  // (and tests) may hand `upsertSticky` a partial config object.
  if ((config.autoPublish?.channelIds ?? []).includes(input.channelId)) {
    throw new StickyError('autoPublishConflict');
  }

  const where = { guildId_channelId: { guildId: input.guildId, channelId: input.channelId } };
  const existing = await ctx.prisma.stickyMessage.findUnique({ where });
  if (!existing) {
    const count = await ctx.prisma.stickyMessage.count({ where: { guildId: input.guildId } });
    if (count >= config.sticky.maxPerGuild)
      throw new StickyError('limit', { max: config.sticky.maxPerGuild });
  }

  const channel = await resolveTextChannel(input.guild, input.channelId);
  if (!channel) throw new StickyError('badChannel');
  if (embed && !channelHasEmbedLinks(input.guild, channel)) {
    throw new StickyError('missingEmbedPermission');
  }

  const data = {
    content,
    // Nullable Json columns need the `Prisma.JsonNull` sentinel to actually clear a previous embed.
    embed: embed ? (embed as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    cooldownSeconds: input.cooldownSeconds,
  };
  const row = await ctx.prisma.stickyMessage.upsert({
    where,
    create: { guildId: input.guildId, channelId: input.channelId, createdBy: input.actorId, ...data },
    update: data,
  });
  await invalidateStickyChannels(ctx, input.guildId);

  const posted = await repostSticky(ctx, input.guild, row);
  await ctx.redis.set(
    stickyCooldownKey(input.guildId, input.channelId),
    '1',
    'EX',
    Math.max(1, input.cooldownSeconds),
  );

  await ctx.audit({
    guildId: input.guildId,
    actorId: input.actorId,
    actorType: 'user',
    action: AuditAction.CommunityStickySet,
    targetType: 'sticky_message',
    targetId: row.id,
    before: existing ? { content: existing.content, cooldownSeconds: existing.cooldownSeconds } : undefined,
    after: {
      channelId: input.channelId,
      content,
      hasEmbed: Boolean(embed),
      cooldownSeconds: input.cooldownSeconds,
    },
    source: 'bot',
  });

  return posted ?? row;
}

/** Deletes the sticky for a channel (DB row + the bot's last posted copy, best-effort). Resolves `false` when there was none. */
export async function removeSticky(
  ctx: PluginContext,
  guildId: string,
  channelId: string,
  actorId: string,
): Promise<boolean> {
  const sticky = await ctx.prisma.stickyMessage.findUnique({
    where: { guildId_channelId: { guildId, channelId } },
  });
  if (!sticky) return false;

  await ctx.prisma.stickyMessage.delete({ where: { id: sticky.id } });
  await invalidateStickyChannels(ctx, guildId);

  if (sticky.lastMessageId) {
    const guild = await ctx.client.guilds.fetch(guildId).catch(() => null);
    const channel = guild ? await resolveTextChannel(guild, channelId) : null;
    if (channel) await deleteOwnMessage(channel, sticky.lastMessageId);
  }

  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: AuditAction.CommunityStickyRemove,
    targetType: 'sticky_message',
    targetId: sticky.id,
    before: { channelId, content: sticky.content, cooldownSeconds: sticky.cooldownSeconds },
    source: 'bot',
  });
  return true;
}

/**
 * Cleans up a sticky when its channel itself was deleted (there's no message to delete — Discord already took
 * the whole channel). Called from the `channelDelete` handler so a deleted channel's sticky doesn't linger as a
 * dangling row (and count against `sticky.maxPerGuild`) or a stale entry in the cached sticky-channel set.
 * Resolves `true` if a sticky was actually removed.
 */
export async function pruneStickyForChannel(
  ctx: PluginContext,
  guildId: string,
  channelId: string,
): Promise<boolean> {
  const { count } = await ctx.prisma.stickyMessage.deleteMany({ where: { guildId, channelId } });
  if (count > 0) await invalidateStickyChannels(ctx, guildId);
  return count > 0;
}
