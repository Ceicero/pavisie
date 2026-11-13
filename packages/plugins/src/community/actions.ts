// Discord/Prisma-touching actions shared between commands, components, and jobs (ARCHITECTURE.md §7.1 folder
// shape: "service.ts — business logic... this is what unit tests target" covers the pure half in service.ts;
// this file is the impure half both commands/*.ts and jobs/*.ts call into so finalize/close/deliver logic is
// never duplicated between the manual (slash command) and automatic (job) paths).
import { randomInt } from 'node:crypto';
import type { Guild, GuildMember, User } from 'discord.js';
import type { CommunityEvent, Giveaway, Poll, Reminder, Suggestion } from '@pavisie/database';
import { redisKey } from '@pavisie/core';
import { fetchMemberSafe, resolveTextChannel, safeDm, type PluginContext } from '../sdk';
import { openTextChannel, type OpenChannelResult } from './channel-access';
import { classifyDiscordFailure, type DiscordFailure } from './discord-errors';
import {
  buildEventComponents,
  buildEventEmbed,
  buildGiveawayComponents,
  buildGiveawayEmbed,
  buildPollComponents,
  buildPollEmbed,
  buildSuggestionComponents,
  buildSuggestionEmbed,
  summarizeRsvps,
  tallyPollFromRows,
} from './render';
import {
  checkGiveawayEligibility,
  pickWinners,
  rerollPool,
  uniqueGiveawayEntries,
  upcomingReminderMinutes,
  type GiveawayEligibilityResult,
} from './service';

/** `crypto.randomInt`-backed rng for `pickWinners` (production draws; tests inject a deterministic sequence instead). */
function cryptoRng(maxExclusive: number): number {
  return maxExclusive <= 0 ? 0 : randomInt(maxExclusive);
}

const GIVEAWAY_ANNOUNCED_TTL_SECONDS = 30 * 24 * 3600;
const EVENT_REMINDED_TTL_SECONDS = 7 * 24 * 3600;

/** Ids whose winner post or ended-message edit still needs another try. Not a per-giveaway TTL — `finalizeGiveaway` retires an id once both steps are settled or the giveaway is older than `GIVEAWAY_ANNOUNCED_TTL_SECONDS`. */
export function giveawayPendingKey(): string {
  return redisKey('community', 'giveaway-pending');
}

export function giveawayAnnouncedKey(giveawayId: string): string {
  return redisKey('community', 'giveaway-announced', giveawayId);
}

/** Set once the original message shows the ended state (button removed), or Discord will never accept that edit. */
export function giveawayMessageClosedKey(giveawayId: string): string {
  return redisKey('community', 'giveaway-message-closed', giveawayId);
}

/** Thrown when a send failed for a reason that may succeed later (network, 5xx). Terminal Discord codes are not this. */
export class RetryableDelivery extends Error {
  constructor() {
    super('community: delivery will be retried');
    this.name = 'RetryableDelivery';
  }
}

type DeliveryResult = 'ok' | 'terminal' | 'retryable';

function deliveryFromFailure(failure: DiscordFailure | 'unavailable' | null): DeliveryResult {
  if (failure === null || failure === 'unavailable') return 'retryable';
  return 'terminal';
}

async function fetchGuild(
  ctx: PluginContext,
  guildId: string,
): Promise<{ ok: true; guild: Guild } | { ok: false; failure: DiscordFailure | 'unavailable' }> {
  try {
    return { ok: true, guild: await ctx.client.guilds.fetch(guildId) };
  } catch (err) {
    const failure = classifyDiscordFailure(err);
    return { ok: false, failure: failure ?? 'unavailable' };
  }
}

function warnDiscord(
  ctx: PluginContext,
  failure: DiscordFailure | 'unavailable',
  fields: Record<string, unknown>,
  message: string,
): void {
  ctx.logger.warn({ ...fields, discordFailure: failure }, message);
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

async function editPollMessage(ctx: PluginContext, poll: Poll): Promise<DeliveryResult> {
  const options = await ctx.prisma.pollOption.findMany({ where: { pollId: poll.id } });
  const votes = await ctx.prisma.pollVote.findMany({ where: { pollId: poll.id } });
  const tallies = tallyPollFromRows(poll, options, votes);
  const payload = {
    embeds: [buildPollEmbed(poll, tallies)],
    components: buildPollComponents(poll.id, options, poll.closed),
  };
  const logContext = { pollId: poll.id, guildId: poll.guildId, channelId: poll.channelId };

  const guild = await fetchGuild(ctx, poll.guildId);
  if (!guild.ok) {
    warnDiscord(ctx, guild.failure, logContext, 'community: could not reach the guild to update a poll');
    return deliveryFromFailure(guild.failure);
  }
  const opened = await openTextChannel(guild.guild, poll.channelId);
  if (!opened.ok) {
    warnDiscord(ctx, opened.failure, logContext, 'community: could not open the poll channel');
    return deliveryFromFailure(opened.failure);
  }

  if (!poll.messageId) {
    if (!poll.closed) return 'ok';
    try {
      await opened.channel.send(payload);
      return 'ok';
    } catch (err) {
      const failure = classifyDiscordFailure(err);
      if (!failure) return 'retryable';
      warnDiscord(ctx, failure, logContext, 'community: could not post poll results');
      return 'terminal';
    }
  }

  try {
    const message = await opened.channel.messages.fetch(poll.messageId);
    await message.edit(payload);
    return 'ok';
  } catch (err) {
    const failure = classifyDiscordFailure(err);
    if (failure === 'unknown_message') {
      if (!poll.closed) return 'terminal';
      try {
        await opened.channel.send(payload);
      } catch (sendErr) {
        const sendFailure = classifyDiscordFailure(sendErr);
        if (!sendFailure) return 'retryable';
        warnDiscord(
          ctx,
          sendFailure,
          logContext,
          'community: could not post poll results after the original message was deleted',
        );
        return 'terminal';
      }
      ctx.logger.info(logContext, 'community: poll message is gone; posted the result separately');
      return 'ok';
    }
    if (!failure) {
      ctx.logger.error({ err, ...logContext }, 'community: editing a poll failed and will be retried');
      return 'retryable';
    }
    warnDiscord(ctx, failure, logContext, 'community: poll message could not be updated');
    return 'terminal';
  }
}

export async function refreshPollMessage(ctx: PluginContext, pollId: string): Promise<void> {
  const poll = await ctx.prisma.poll.findUnique({ where: { id: pollId } });
  if (!poll) return;
  await editPollMessage(ctx, poll);
}

/** Closes a poll (idempotent) and re-renders its message with final results, including a tie when several options lead. */
export async function closePoll(ctx: PluginContext, pollId: string): Promise<Poll | null> {
  const existing = await ctx.prisma.poll.findUnique({ where: { id: pollId } });
  if (!existing) return null;

  let closedNow = false;
  let updated = existing;
  if (!existing.closed) {
    updated = await ctx.prisma.poll.update({ where: { id: pollId }, data: { closed: true } });
    closedNow = true;
  }

  const rendered = await editPollMessage(ctx, updated);
  if (rendered === 'retryable') {
    if (closedNow) {
      await ctx.prisma.poll.update({ where: { id: pollId }, data: { closed: false } });
    }
    throw new RetryableDelivery();
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Giveaways
// ---------------------------------------------------------------------------

async function editGiveawayMessage(
  ctx: PluginContext,
  giveaway: Giveaway,
  entryCount: number,
): Promise<DeliveryResult> {
  if (!giveaway.messageId) return 'ok';
  const logContext = { giveawayId: giveaway.id, guildId: giveaway.guildId, channelId: giveaway.channelId };
  const guild = await fetchGuild(ctx, giveaway.guildId);
  if (!guild.ok) {
    warnDiscord(ctx, guild.failure, logContext, 'community: could not reach the guild to update a giveaway');
    return deliveryFromFailure(guild.failure);
  }
  const opened = await openTextChannel(guild.guild, giveaway.channelId);
  if (!opened.ok) {
    warnDiscord(ctx, opened.failure, logContext, 'community: could not open the giveaway channel');
    return deliveryFromFailure(opened.failure);
  }

  try {
    const message = await opened.channel.messages.fetch(giveaway.messageId);
    await message.edit({
      embeds: [buildGiveawayEmbed(giveaway, entryCount)],
      components: buildGiveawayComponents(giveaway.id, giveaway.ended),
    });
    return 'ok';
  } catch (err) {
    const failure = classifyDiscordFailure(err);
    if (!failure) {
      ctx.logger.error({ err, ...logContext }, 'community: editing a giveaway failed and will be retried');
      return 'retryable';
    }
    // 10003 / 10008 / 50001 / 50013 will not start succeeding on the next pass.
    warnDiscord(ctx, failure, logContext, 'community: giveaway message could not be edited');
    return 'terminal';
  }
}

async function announceWinners(
  ctx: PluginContext,
  giveaway: Giveaway,
  winnerIds: string[],
): Promise<DeliveryResult> {
  const logContext = { giveawayId: giveaway.id, guildId: giveaway.guildId, channelId: giveaway.channelId };
  const guild = await fetchGuild(ctx, giveaway.guildId);
  if (!guild.ok) {
    warnDiscord(
      ctx,
      guild.failure,
      logContext,
      'community: could not reach the guild to announce giveaway winners',
    );
    return deliveryFromFailure(guild.failure);
  }

  const content =
    winnerIds.length > 0
      ? `🎉 Congratulations ${winnerIds.map((id) => `<@${id}>`).join(', ')}! You won **${giveaway.prize}**.`
      : `😔 No valid entries for **${giveaway.prize}** — no winner could be drawn.`;

  let posted = false;
  const opened = await openTextChannel(guild.guild, giveaway.channelId);
  if (!opened.ok) {
    warnDiscord(ctx, opened.failure, logContext, 'community: could not announce giveaway winners in channel');
    if (opened.failure === 'unavailable') return 'retryable';
  } else {
    try {
      await opened.channel.send({ content, allowedMentions: { users: winnerIds } });
      posted = true;
    } catch (err) {
      const failure = classifyDiscordFailure(err);
      if (!failure) {
        ctx.logger.error(
          { err, ...logContext },
          'community: announcing giveaway winners failed and will be retried',
        );
        return 'retryable';
      }
      warnDiscord(ctx, failure, logContext, 'community: could not announce giveaway winners in channel');
    }
  }

  for (const userId of winnerIds) {
    const member = await fetchMemberSafe(guild.guild, userId);
    if (member) {
      await safeDm(
        member.user,
        `🎉 You won **${giveaway.prize}** in **${guild.guild.name}**! Congratulations.`,
      );
    }
  }
  return posted ? 'ok' : 'terminal';
}

/**
 * Ends a giveaway (idempotent). Winners are stored on the row before anything is posted, so a later catch-up
 * announces those same ids and does not draw again. The winner post and the edit that removes the Enter
 * button are tracked separately: a transient failure of one is retried without repeating the other. Permanent
 * Discord errors (unknown channel/message, missing access/permissions) are recorded so they are not retried.
 */
export async function finalizeGiveaway(ctx: PluginContext, giveawayId: string): Promise<Giveaway | null> {
  const announcedKey = giveawayAnnouncedKey(giveawayId);
  const closedKey = giveawayMessageClosedKey(giveawayId);
  const pendingKey = giveawayPendingKey();

  if ((await ctx.redis.get(announcedKey)) && (await ctx.redis.get(closedKey))) {
    await ctx.redis.srem(pendingKey, giveawayId);
    return ctx.prisma.giveaway.findUnique({ where: { id: giveawayId } });
  }

  let record = await ctx.prisma.giveaway.findUnique({
    where: { id: giveawayId },
    include: { entries: true },
  });
  if (!record) return null;

  let winnerIds = record.winnerIds;
  let giveaway: Giveaway = record;
  if (!record.ended) {
    const winners = pickWinners(uniqueGiveawayEntries(record.entries), record.winnerCount, cryptoRng);
    winnerIds = winners.map((winner) => winner.userId);
    const claim = await ctx.prisma.giveaway.updateMany({
      where: { id: giveawayId, ended: false },
      data: { ended: true, winnerIds },
    });
    if (claim.count === 0) {
      // Another worker stored the winners. Announce those ids; don't draw a second set.
      const current = await ctx.prisma.giveaway.findUnique({
        where: { id: giveawayId },
        include: { entries: true },
      });
      if (!current) return null;
      record = current;
      winnerIds = current.winnerIds;
      giveaway = current;
    } else {
      giveaway = { ...record, ended: true, winnerIds };
    }
  }

  const lockKey = redisKey('community', 'giveaway-announce-lock', giveawayId);
  const lock = await ctx.redis.set(lockKey, '1', 'EX', 60, 'NX');
  if (lock !== 'OK') return giveaway;

  try {
    let messageSettled = Boolean(await ctx.redis.get(closedKey));
    let winnersSettled = Boolean(await ctx.redis.get(announcedKey));
    if (messageSettled && winnersSettled) {
      await ctx.redis.srem(pendingKey, giveawayId);
      return giveaway;
    }

    if (!messageSettled) {
      const edited = await editGiveawayMessage(ctx, giveaway, record.entries.length);
      if (edited !== 'retryable') {
        await ctx.redis.set(closedKey, '1', 'EX', GIVEAWAY_ANNOUNCED_TTL_SECONDS);
        messageSettled = true;
      }
    }

    if (!winnersSettled) {
      const announced = await announceWinners(ctx, giveaway, winnerIds);
      if (announced !== 'retryable') {
        await ctx.redis.set(announcedKey, '1', 'EX', GIVEAWAY_ANNOUNCED_TTL_SECONDS);
        winnersSettled = true;
      }
    }

    if (messageSettled && winnersSettled) {
      await ctx.redis.srem(pendingKey, giveawayId);
      return giveaway;
    }

    // Unclassified failures (network, 5xx) stay pending so catch-up can try again. Past the announcement
    // TTL they are retired — a deleted channel that never produced a Discord code must not retry forever.
    const ageMs = Date.now() - new Date(giveaway.endsAt).getTime();
    if (ageMs > GIVEAWAY_ANNOUNCED_TTL_SECONDS * 1000) {
      ctx.logger.warn(
        { giveawayId, guildId: giveaway.guildId, ageMs },
        'community: giving up on a giveaway announcement that is still failing',
      );
      if (!messageSettled) await ctx.redis.set(closedKey, '1', 'EX', GIVEAWAY_ANNOUNCED_TTL_SECONDS);
      if (!winnersSettled) await ctx.redis.set(announcedKey, '1', 'EX', GIVEAWAY_ANNOUNCED_TTL_SECONDS);
      await ctx.redis.srem(pendingKey, giveawayId);
      return giveaway;
    }

    await ctx.redis.sadd(pendingKey, giveawayId);
    throw new RetryableDelivery();
  } finally {
    await ctx.redis.del(lockKey);
  }
}

/**
 * Rerolls winners from entries who have not already won. When nobody new is left (zero or one entrant who
 * already won), the stored winners are left unchanged and nothing is announced.
 */
export async function rerollGiveaway(
  ctx: PluginContext,
  giveawayId: string,
  count?: number,
): Promise<{ giveaway: Giveaway; winnerIds: string[] } | null> {
  const existing = await ctx.prisma.giveaway.findUnique({
    where: { id: giveawayId },
    include: { entries: true },
  });
  if (!existing || !existing.ended) return null;

  const n = count ?? existing.winnerCount;
  const pool = rerollPool(existing.entries, existing.winnerIds, n);
  const winners = pickWinners(pool, n, cryptoRng);
  const winnerIds = winners.map((winner) => winner.userId);
  if (winnerIds.length === 0) return { giveaway: existing, winnerIds: [] };

  const updated = await ctx.prisma.giveaway.update({ where: { id: giveawayId }, data: { winnerIds } });
  await editGiveawayMessage(ctx, updated, existing.entries.length);
  await announceWinners(ctx, updated, winnerIds);
  return { giveaway: updated, winnerIds };
}

/** Cancels a giveaway before it ends: marks it ended with no winners and removes its scheduled end job. */
export async function cancelGiveaway(ctx: PluginContext, giveawayId: string): Promise<void> {
  const updated = await ctx.prisma.giveaway.update({
    where: { id: giveawayId },
    data: { ended: true, winnerIds: [] },
  });
  await ctx.redis
    .set(giveawayAnnouncedKey(giveawayId), '1', 'EX', GIVEAWAY_ANNOUNCED_TTL_SECONDS)
    .catch(() => undefined);
  await ctx.redis
    .set(giveawayMessageClosedKey(giveawayId), '1', 'EX', GIVEAWAY_ANNOUNCED_TTL_SECONDS)
    .catch(() => undefined);
  await ctx.redis.srem(giveawayPendingKey(), giveawayId).catch(() => undefined);
  await ctx
    .queue('giveaway-end')
    .remove(`gw-${giveawayId}`)
    .catch(() => undefined);
  if (!updated.messageId) return;

  const guild = await fetchGuild(ctx, updated.guildId);
  if (!guild.ok) {
    warnDiscord(
      ctx,
      guild.failure,
      { giveawayId },
      'community: could not reach the guild to cancel a giveaway post',
    );
    return;
  }
  const opened = await openTextChannel(guild.guild, updated.channelId);
  if (!opened.ok) {
    warnDiscord(
      ctx,
      opened.failure,
      { giveawayId },
      'community: could not open the channel to cancel a giveaway post',
    );
    return;
  }
  try {
    const message = await opened.channel.messages.fetch(updated.messageId);
    await message.edit({
      content: 'This giveaway was cancelled.',
      embeds: [buildGiveawayEmbed(updated, 0)],
      components: [],
    });
  } catch (err) {
    const failure = classifyDiscordFailure(err) ?? 'unavailable';
    warnDiscord(ctx, failure, { giveawayId }, 'community: giveaway cancel could not edit the post');
  }
}

export async function evaluateGiveawayEligibility(
  ctx: PluginContext,
  giveaway: Giveaway,
  member: GuildMember,
): Promise<GiveawayEligibilityResult> {
  let level = 0;
  if (giveaway.minLevel !== null) {
    const profile = await ctx.prisma.levelProfile.findUnique({
      where: { guildId_userId: { guildId: giveaway.guildId, userId: member.id } },
    });
    level = profile?.level ?? 0;
  }
  return checkGiveawayEligibility({
    giveaway: {
      ended: giveaway.ended,
      requiredRoleIds: giveaway.requiredRoleIds,
      minAccountAgeDays: giveaway.minAccountAgeDays,
      minLevel: giveaway.minLevel,
    },
    member: { roleIds: [...member.roles.cache.keys()], accountCreatedAt: member.user.createdAt, level },
    now: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

async function forgetSuggestionPost(
  ctx: PluginContext,
  suggestionId: string,
  failure: DiscordFailure,
): Promise<void> {
  await ctx.prisma.suggestion.update({
    where: { id: suggestionId },
    data: {
      messageId: null,
      ...(failure === 'unknown_channel' || failure === 'unknown_guild' ? { threadId: null } : {}),
    },
  });
}

async function openSuggestionChannel(
  ctx: PluginContext,
  suggestion: Suggestion,
): Promise<OpenChannelResult | { ok: false; failure: DiscordFailure | 'unavailable' }> {
  const guild = await fetchGuild(ctx, suggestion.guildId);
  if (!guild.ok) return guild;
  return openTextChannel(guild.guild, suggestion.channelId);
}

/**
 * Re-renders a suggestion's Discord embed, or deletes the post once the row is soft-deleted.
 * A missing channel (10003) or message (10008) clears the stored ids so later syncs don't keep editing a
 * ghost. Missing access/permissions (50001/50013) are logged and the ids are kept for a later retry.
 */
export async function syncSuggestionMessage(ctx: PluginContext, suggestion: Suggestion): Promise<void> {
  if (!suggestion.messageId) return;
  const logContext = {
    suggestionId: suggestion.id,
    guildId: suggestion.guildId,
    channelId: suggestion.channelId,
  };
  const opened = await openSuggestionChannel(ctx, suggestion);
  if (!opened.ok) {
    if (opened.failure === 'unknown_channel' || opened.failure === 'unknown_guild') {
      await forgetSuggestionPost(ctx, suggestion.id, opened.failure);
    }
    warnDiscord(ctx, opened.failure, logContext, 'community: could not open the suggestions channel');
    return;
  }

  if (suggestion.deletedAt) {
    try {
      await opened.channel.messages.delete(suggestion.messageId);
      await forgetSuggestionPost(ctx, suggestion.id, 'unknown_message');
    } catch (err) {
      const failure = classifyDiscordFailure(err);
      if (failure === 'unknown_message' || failure === 'unknown_channel') {
        await forgetSuggestionPost(ctx, suggestion.id, failure);
        return;
      }
      if (!failure) {
        ctx.logger.error({ err, ...logContext }, 'community: deleting a suggestion post failed');
        return;
      }
      warnDiscord(ctx, failure, logContext, 'community: could not delete a suggestion post');
    }
    return;
  }

  try {
    const message = await opened.channel.messages.fetch(suggestion.messageId);
    await message.edit({
      embeds: [buildSuggestionEmbed(suggestion)],
      components: buildSuggestionComponents(suggestion.id),
    });
  } catch (err) {
    const failure = classifyDiscordFailure(err);
    if (failure === 'unknown_message' || failure === 'unknown_channel') {
      await forgetSuggestionPost(ctx, suggestion.id, failure);
      ctx.logger.info(logContext, 'community: suggestion message is gone; cleared the stored id');
      return;
    }
    if (!failure) {
      ctx.logger.error({ err, ...logContext }, 'community: editing a suggestion failed');
      return;
    }
    warnDiscord(ctx, failure, logContext, 'community: suggestion message could not be edited');
  }
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export interface AnnouncementContent {
  content: string;
}

/** Sends a scheduled announcement's message and updates bookkeeping (`lastRunAt`, and disables one-off announcements after their single run). */
export async function runAnnouncement(ctx: PluginContext, announcementId: string): Promise<void> {
  const announcement = await ctx.prisma.scheduledAnnouncement.findUnique({ where: { id: announcementId } });
  if (!announcement || !announcement.enabled) return;

  const guild = await ctx.client.guilds.fetch(announcement.guildId).catch(() => null);
  if (!guild) return;
  const channel = await resolveTextChannel(guild, announcement.channelId);
  const body = announcement.content as unknown as AnnouncementContent | null;
  if (!channel || !body?.content) return;

  await channel
    .send({ content: body.content, allowedMentions: { parse: ['users', 'roles'] } })
    .catch((err) => {
      ctx.logger.warn({ err, announcementId }, 'community: failed to send a scheduled announcement');
    });

  const isOneOff = !announcement.cron;
  await ctx.prisma.scheduledAnnouncement.update({
    where: { id: announcement.id },
    data: { lastRunAt: new Date(), ...(isOneOff ? { enabled: false } : {}) },
  });
}

/** Cancels a scheduled announcement: disables it and removes its BullMQ job/scheduler. */
export async function cancelAnnouncement(
  ctx: PluginContext,
  announcementId: string,
  cron: string | null,
): Promise<void> {
  await ctx.prisma.scheduledAnnouncement.update({ where: { id: announcementId }, data: { enabled: false } });
  const queue = ctx.queue('announcement-run');
  if (cron) {
    await queue.removeJobScheduler(`ann-${announcementId}`).catch(() => undefined);
  } else {
    await queue.remove(`ann-${announcementId}`).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

async function dmReminder(ctx: PluginContext, userId: string, text: string): Promise<DeliveryResult> {
  let user: User | null;
  try {
    user = await ctx.client.users.fetch(userId);
  } catch (err) {
    const failure = classifyDiscordFailure(err);
    if (!failure) throw new RetryableDelivery();
    warnDiscord(ctx, failure, { userId }, 'community: could not fetch the reminder recipient');
    return 'terminal';
  }
  try {
    await user.send(text);
    return 'ok';
  } catch (err) {
    const failure = classifyDiscordFailure(err);
    if (!failure) throw new RetryableDelivery();
    warnDiscord(ctx, failure, { userId }, 'community: could not DM a reminder');
    return 'terminal';
  }
}

/** Sends a reminder in its channel, falling back to a DM when the channel is gone or the bot cannot post there. */
async function sendReminder(ctx: PluginContext, reminder: Reminder): Promise<void> {
  const text = `⏰ Reminder: ${reminder.content}`;
  const logContext = { reminderId: reminder.id, guildId: reminder.guildId, channelId: reminder.channelId };

  if (reminder.channelId && reminder.guildId) {
    const guild = await fetchGuild(ctx, reminder.guildId);
    if (!guild.ok) {
      warnDiscord(
        ctx,
        guild.failure,
        logContext,
        'community: could not reach the guild for a channel reminder',
      );
      if (guild.failure === 'unavailable') throw new RetryableDelivery();
    } else {
      const opened = await openTextChannel(guild.guild, reminder.channelId);
      if (!opened.ok) {
        warnDiscord(
          ctx,
          opened.failure,
          logContext,
          'community: channel reminder could not be posted; falling back to DM',
        );
        if (opened.failure === 'unavailable') throw new RetryableDelivery();
      } else {
        try {
          await opened.channel.send({
            content: `<@${reminder.userId}> ${text}`,
            allowedMentions: { users: [reminder.userId] },
          });
          return;
        } catch (err) {
          const failure = classifyDiscordFailure(err);
          if (!failure) throw new RetryableDelivery();
          warnDiscord(
            ctx,
            failure,
            logContext,
            'community: channel reminder was rejected; falling back to DM',
          );
        }
      }
    }
  }

  await dmReminder(ctx, reminder.userId, text);
}

/**
 * Delivers one reminder. One-off reminders are claimed with a conditional update so a sweep and a delayed job
 * cannot both send. Recurring reminders stay `delivered: false` so they remain listable, and a short lock stops
 * the same tick from firing twice. A deleted channel or missing permissions falls back to a DM instead of
 * marking the reminder sent and dropping it.
 */
export async function deliverReminder(ctx: PluginContext, reminderId: string): Promise<void> {
  const reminder = await ctx.prisma.reminder.findUnique({ where: { id: reminderId } });
  if (!reminder) return;

  if (reminder.recurring) {
    const lockKey = redisKey('community', 'reminder-lock', reminder.id);
    const lock = await ctx.redis.set(lockKey, '1', 'EX', 30, 'NX');
    if (lock !== 'OK') return;
    try {
      await sendReminder(ctx, reminder);
      await ctx.prisma.reminder.update({
        where: { id: reminder.id },
        data: { deliveredAt: new Date() },
      });
    } catch (err) {
      await ctx.redis.del(lockKey);
      if (err instanceof RetryableDelivery) throw err;
      ctx.logger.warn({ err, reminderId }, 'community: recurring reminder failed');
    }
    return;
  }

  if (reminder.delivered) return;
  const claim = await ctx.prisma.reminder.updateMany({
    where: { id: reminder.id, delivered: false },
    data: { delivered: true, deliveredAt: new Date() },
  });
  if (claim.count === 0) return;

  try {
    await sendReminder(ctx, reminder);
  } catch (err) {
    if (err instanceof RetryableDelivery) {
      await ctx.prisma.reminder.update({
        where: { id: reminder.id },
        data: { delivered: false, deliveredAt: null },
      });
      throw err;
    }
    ctx.logger.warn({ err, reminderId }, 'community: reminder could not be delivered');
  }
}

/** Cancels a reminder: marks it delivered (so the sweep skips it) and removes its scheduled job. */
export async function cancelReminder(
  ctx: PluginContext,
  reminderId: string,
  recurring: string | null,
): Promise<void> {
  await ctx.prisma.reminder.update({
    where: { id: reminderId },
    data: { delivered: true, deliveredAt: new Date() },
  });
  const queue = ctx.queue('reminder-deliver');
  if (recurring) {
    await queue.removeJobScheduler(`rem-${reminderId}`).catch(() => undefined);
  } else {
    await queue.remove(`rem-${reminderId}`).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function refreshEventMessage(
  ctx: PluginContext,
  event: CommunityEvent,
  cancelled = false,
): Promise<void> {
  if (!event.messageId || !event.channelId) return;
  const logContext = { eventId: event.id, guildId: event.guildId, channelId: event.channelId };
  const guild = await fetchGuild(ctx, event.guildId);
  if (!guild.ok) {
    warnDiscord(ctx, guild.failure, logContext, 'community: could not reach the guild to update an event');
    return;
  }
  const opened = await openTextChannel(guild.guild, event.channelId);
  if (!opened.ok) {
    warnDiscord(ctx, opened.failure, logContext, 'community: could not open the event channel');
    return;
  }

  const rsvps = await ctx.prisma.eventRsvp.findMany({ where: { eventId: event.id } });
  const counts = summarizeRsvps(rsvps);

  try {
    const message = await opened.channel.messages.fetch(event.messageId);
    await message.edit({
      embeds: [buildEventEmbed(event, counts, cancelled)],
      components: buildEventComponents(event.id, cancelled),
    });
  } catch (err) {
    const failure = classifyDiscordFailure(err) ?? 'unavailable';
    warnDiscord(ctx, failure, logContext, 'community: event message could not be edited');
  }
}

/** Cancels a community event: marks its Discord message cancelled, cancels the native scheduled event (if any), and removes pending reminder jobs. */
export async function cancelEvent(ctx: PluginContext, eventId: string): Promise<CommunityEvent | null> {
  const event = await ctx.prisma.communityEvent.findUnique({ where: { id: eventId } });
  if (!event) return null;

  await refreshEventMessage(ctx, event, true);

  if (event.discordEventId) {
    const guild = await ctx.client.guilds.fetch(event.guildId).catch(() => null);
    if (guild) {
      await guild.scheduledEvents.delete(event.discordEventId).catch(() => undefined);
    }
  }

  const queue = ctx.queue('event-reminder');
  const stillDue = upcomingReminderMinutes(event.reminderMinutes, event.startsAt, new Date());
  for (const minutes of stillDue) {
    await queue.remove(`ev-${event.id}-${minutes}`).catch(() => undefined);
  }
  for (const minutes of event.reminderMinutes) {
    await queue.remove(`ev-${event.id}-${minutes}`).catch(() => undefined);
  }

  await ctx.prisma.communityEvent.delete({ where: { id: eventId } });
  return event;
}

/** Announces an upcoming event reminder in its channel (fired by the `event-reminder` job). Splits mentions
 * across multiple messages if needed to stay within Discord's limits (2000 char per message, 100 mentions per
 * allowed-mentions list). Logs errors so failures are diagnosable. */
export async function fireEventReminder(
  ctx: PluginContext,
  eventId: string,
  minutesBefore: number,
): Promise<void> {
  const doneKey = redisKey('community', 'event-reminded', eventId, String(minutesBefore));
  if (await ctx.redis.get(doneKey)) return;

  const event = await ctx.prisma.communityEvent.findUnique({ where: { id: eventId } });
  if (!event || !event.channelId) return;

  const lockKey = redisKey('community', 'event-remind-lock', eventId, String(minutesBefore));
  const lock = await ctx.redis.set(lockKey, '1', 'EX', 120, 'NX');
  if (lock !== 'OK') return;

  const logContext = { eventId, guildId: event.guildId, channelId: event.channelId, minutesBefore };
  try {
    if (await ctx.redis.get(doneKey)) return;

    const rsvps = await ctx.prisma.eventRsvp.findMany({ where: { eventId: event.id, status: 'GOING' } });
    if (rsvps.length === 0) return;

    const guild = await fetchGuild(ctx, event.guildId);
    if (!guild.ok) {
      warnDiscord(
        ctx,
        guild.failure,
        logContext,
        'community: could not reach the guild for an event reminder',
      );
      if (guild.failure === 'unavailable') throw new RetryableDelivery();
      await ctx.redis.set(doneKey, '1', 'EX', EVENT_REMINDED_TTL_SECONDS);
      return;
    }
    const opened = await openTextChannel(guild.guild, event.channelId);
    if (!opened.ok) {
      warnDiscord(ctx, opened.failure, logContext, 'community: could not post an event reminder');
      if (opened.failure === 'unavailable') throw new RetryableDelivery();
      await ctx.redis.set(doneKey, '1', 'EX', EVENT_REMINDED_TTL_SECONDS);
      return;
    }

    const header = `📅 **${event.title}** starts in ${minutesBefore} minute${minutesBefore === 1 ? '' : 's'}!`;
    const continued = `**${event.title}** (continued):`;

    // Discord caps a message at 2000 characters and an allowed-mentions list at 100 users. A well-attended event
    // blows through both, and the whole send is rejected — so ping across as many messages as it takes.
    const MAX_MENTIONS_PER_MESSAGE = 100;
    const MAX_CHARS_PER_MESSAGE = 2000;
    const prefixBudget = Math.max(header.length, continued.length);

    const batches: string[][] = [];
    let batch: string[] = [];
    let length = prefixBudget;
    for (const { userId } of rsvps) {
      const mentionLength = userId.length + 4; // `<@` + id + `>` plus the separating space
      if (
        batch.length >= MAX_MENTIONS_PER_MESSAGE ||
        (batch.length > 0 && length + mentionLength > MAX_CHARS_PER_MESSAGE)
      ) {
        batches.push(batch);
        batch = [];
        length = prefixBudget;
      }
      batch.push(userId);
      length += mentionLength;
    }
    if (batch.length > 0) batches.push(batch);

    for (const [index, userIds] of batches.entries()) {
      const mentions = userIds.map((id) => `<@${id}>`).join(' ');
      try {
        await opened.channel.send({
          content: index === 0 ? `${header} ${mentions}` : `${continued} ${mentions}`,
          allowedMentions: { users: userIds },
        });
      } catch (err) {
        const failure = classifyDiscordFailure(err);
        if (!failure) {
          ctx.logger.error(
            { err, ...logContext, batch: index },
            'community: event reminder failed and will be retried',
          );
          throw new RetryableDelivery();
        }
        warnDiscord(ctx, failure, { ...logContext, batch: index }, 'community: event reminder was rejected');
        await ctx.redis.set(doneKey, '1', 'EX', EVENT_REMINDED_TTL_SECONDS);
        return;
      }
    }

    await ctx.redis.set(doneKey, '1', 'EX', EVENT_REMINDED_TTL_SECONDS);
  } finally {
    await ctx.redis.del(lockKey);
  }
}
