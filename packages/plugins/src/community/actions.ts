// Discord/Prisma-touching actions shared between commands, components, and jobs (ARCHITECTURE.md §7.1 folder
// shape: "service.ts — business logic... this is what unit tests target" covers the pure half in service.ts;
// this file is the impure half both commands/*.ts and jobs/*.ts call into so finalize/close/deliver logic is
// never duplicated between the manual (slash command) and automatic (job) paths).
import { randomInt } from 'node:crypto';
import type { GuildMember } from 'discord.js';
import type { CommunityEvent, Giveaway, Poll, Suggestion } from '@entrophy/database';
import { fetchMemberSafe, resolveTextChannel, safeDm, type PluginContext } from '../sdk';
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
  upcomingReminderMinutes,
  type GiveawayEligibilityResult,
} from './service';

/** `crypto.randomInt`-backed rng for `pickWinners` (production draws; tests inject a deterministic sequence instead). */
function cryptoRng(maxExclusive: number): number {
  return maxExclusive <= 0 ? 0 : randomInt(maxExclusive);
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

async function editPollMessage(ctx: PluginContext, poll: Poll): Promise<void> {
  if (!poll.messageId) return;
  const guild = await ctx.client.guilds.fetch(poll.guildId).catch(() => null);
  if (!guild) return;
  const channel = await resolveTextChannel(guild, poll.channelId);
  if (!channel) return;

  const options = await ctx.prisma.pollOption.findMany({ where: { pollId: poll.id } });
  const votes = await ctx.prisma.pollVote.findMany({ where: { pollId: poll.id } });
  const tallies = tallyPollFromRows(poll, options, votes);

  try {
    const message = await channel.messages.fetch(poll.messageId);
    await message.edit({
      embeds: [buildPollEmbed(poll, tallies)],
      components: buildPollComponents(poll.id, options, poll.closed),
    });
  } catch {
    // Message may have been deleted; nothing to update.
  }
}

export async function refreshPollMessage(ctx: PluginContext, pollId: string): Promise<void> {
  const poll = await ctx.prisma.poll.findUnique({ where: { id: pollId } });
  if (!poll) return;
  await editPollMessage(ctx, poll);
}

/** Closes a poll (idempotent — a no-op if already closed) and re-renders its message with final results. */
export async function closePoll(ctx: PluginContext, pollId: string): Promise<Poll | null> {
  const existing = await ctx.prisma.poll.findUnique({ where: { id: pollId } });
  if (!existing || existing.closed) return existing;

  const updated = await ctx.prisma.poll.update({ where: { id: pollId }, data: { closed: true } });
  await editPollMessage(ctx, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// Giveaways
// ---------------------------------------------------------------------------

async function editGiveawayMessage(
  ctx: PluginContext,
  giveaway: Giveaway,
  entryCount: number,
): Promise<void> {
  if (!giveaway.messageId) return;
  const guild = await ctx.client.guilds.fetch(giveaway.guildId).catch(() => null);
  if (!guild) return;
  const channel = await resolveTextChannel(guild, giveaway.channelId);
  if (!channel) return;

  try {
    const message = await channel.messages.fetch(giveaway.messageId);
    await message.edit({
      embeds: [buildGiveawayEmbed(giveaway, entryCount)],
      components: buildGiveawayComponents(giveaway.id, giveaway.ended),
    });
  } catch {
    // Message may have been deleted; nothing to update.
  }
}

async function announceWinners(ctx: PluginContext, giveaway: Giveaway, winnerIds: string[]): Promise<void> {
  const guild = await ctx.client.guilds.fetch(giveaway.guildId).catch(() => null);
  if (!guild) return;

  const channel = await resolveTextChannel(guild, giveaway.channelId);
  if (channel) {
    const content =
      winnerIds.length > 0
        ? `🎉 Congratulations ${winnerIds.map((id) => `<@${id}>`).join(', ')}! You won **${giveaway.prize}**.`
        : `😔 No valid entries for **${giveaway.prize}** — no winner could be drawn.`;
    await channel.send({ content, allowedMentions: { users: winnerIds } }).catch(() => undefined);
  }

  for (const userId of winnerIds) {
    const member = await fetchMemberSafe(guild, userId);
    if (member) {
      await safeDm(member.user, `🎉 You won **${giveaway.prize}** in **${guild.name}**! Congratulations.`);
    }
  }
}

/** Ends a giveaway (idempotent), drawing winners with `crypto.randomInt`, announcing them, and DMing each winner. */
export async function finalizeGiveaway(ctx: PluginContext, giveawayId: string): Promise<Giveaway | null> {
  const existing = await ctx.prisma.giveaway.findUnique({
    where: { id: giveawayId },
    include: { entries: true },
  });
  if (!existing || existing.ended) return existing ?? null;

  const winners = pickWinners(existing.entries, existing.winnerCount, cryptoRng);
  const winnerIds = winners.map((w) => w.userId);

  const updated = await ctx.prisma.giveaway.update({
    where: { id: giveawayId },
    data: { ended: true, winnerIds },
  });
  await editGiveawayMessage(ctx, updated, existing.entries.length);
  await announceWinners(ctx, updated, winnerIds);
  return updated;
}

/** Rerolls a giveaway's winners (must already have ended), excluding previous winners when there are enough other entries. */
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
  const withoutPrevious = existing.entries.filter((e) => !existing.winnerIds.includes(e.userId));
  const pool = withoutPrevious.length >= n ? withoutPrevious : existing.entries;

  const winners = pickWinners(pool, n, cryptoRng);
  const winnerIds = winners.map((w) => w.userId);

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
  await ctx
    .queue('giveaway-end')
    .remove(`gw-${giveawayId}`)
    .catch(() => undefined);
  if (updated.messageId) {
    const guild = await ctx.client.guilds.fetch(updated.guildId).catch(() => null);
    const channel = guild ? await resolveTextChannel(guild, updated.channelId) : null;
    if (channel) {
      try {
        const message = await channel.messages.fetch(updated.messageId);
        await message.edit({
          content: 'This giveaway was cancelled.',
          embeds: [buildGiveawayEmbed(updated, 0)],
          components: [],
        });
      } catch {
        // Message may already be gone.
      }
    }
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

/** Re-renders a suggestion's Discord embed/components from its current DB row — used after any status/vote change, and by the periodic `suggestion-sync` job that reflects dashboard edits. */
export async function syncSuggestionMessage(ctx: PluginContext, suggestion: Suggestion): Promise<void> {
  if (!suggestion.messageId) return;
  const guild = await ctx.client.guilds.fetch(suggestion.guildId).catch(() => null);
  if (!guild) return;
  const channel = await resolveTextChannel(guild, suggestion.channelId);
  if (!channel) return;

  try {
    const message = await channel.messages.fetch(suggestion.messageId);
    await message.edit({
      embeds: [buildSuggestionEmbed(suggestion)],
      components: buildSuggestionComponents(suggestion.id),
    });
  } catch {
    // Message may have been deleted.
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

/** Delivers one reminder (DM, or a channel ping when a channel was chosen) and marks it delivered. Safe to call more than once for a recurring reminder. */
export async function deliverReminder(ctx: PluginContext, reminderId: string): Promise<void> {
  const reminder = await ctx.prisma.reminder.findUnique({ where: { id: reminderId } });
  if (!reminder) return;
  if (reminder.delivered && !reminder.recurring) return;

  const text = `⏰ Reminder: ${reminder.content}`;

  if (reminder.channelId && reminder.guildId) {
    const guild = await ctx.client.guilds.fetch(reminder.guildId).catch(() => null);
    const channel = guild ? await resolveTextChannel(guild, reminder.channelId) : null;
    if (channel) {
      await channel
        .send({ content: `<@${reminder.userId}> ${text}`, allowedMentions: { users: [reminder.userId] } })
        .catch((err) => {
          ctx.logger.warn({ err, reminderId }, 'community: failed to deliver a channel reminder');
        });
    }
  } else {
    const user = await ctx.client.users.fetch(reminder.userId).catch(() => null);
    if (user) {
      await safeDm(user, text);
    }
  }

  await ctx.prisma.reminder.update({
    where: { id: reminder.id },
    data: { delivered: true, deliveredAt: new Date() },
  });
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
  if (!event.messageId) return;
  const guild = await ctx.client.guilds.fetch(event.guildId).catch(() => null);
  if (!guild || !event.channelId) return;
  const channel = await resolveTextChannel(guild, event.channelId);
  if (!channel) return;

  const rsvps = await ctx.prisma.eventRsvp.findMany({ where: { eventId: event.id } });
  const counts = summarizeRsvps(rsvps);

  try {
    const message = await channel.messages.fetch(event.messageId);
    await message.edit({
      embeds: [buildEventEmbed(event, counts, cancelled)],
      components: buildEventComponents(event.id, cancelled),
    });
  } catch {
    // Message may have been deleted.
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
  const event = await ctx.prisma.communityEvent.findUnique({ where: { id: eventId } });
  if (!event || !event.channelId) return;

  const rsvps = await ctx.prisma.eventRsvp.findMany({ where: { eventId: event.id, status: 'GOING' } });
  if (rsvps.length === 0) return;

  const guild = await ctx.client.guilds.fetch(event.guildId).catch(() => null);
  const channel = guild ? await resolveTextChannel(guild, event.channelId) : null;
  if (!channel) return;

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
    if (batch.length >= MAX_MENTIONS_PER_MESSAGE || (batch.length > 0 && length + mentionLength > MAX_CHARS_PER_MESSAGE)) {
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
      await channel.send({
        content: index === 0 ? `${header} ${mentions}` : `${continued} ${mentions}`,
        allowedMentions: { users: userIds },
      });
    } catch (err) {
      // Previously swallowed, which meant a reminder that never arrived left no trace anywhere.
      ctx.logger.error(
        { err, eventId, guildId: event.guildId, channelId: event.channelId, minutesBefore, batch: index },
        'community: failed to send an event reminder message',
      );
    }
  }
}
