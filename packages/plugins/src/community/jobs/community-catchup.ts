import type { PluginContext, PluginJob } from '../../sdk';
import { closePoll, finalizeGiveaway, fireEventReminder } from '../actions';

/** How long after a reminder's fire time a restart may still send it. Later than this, the ping would be stale. */
const REMINDER_GRACE_MS = 15 * 60_000;

export interface CommunityCatchupResult {
  giveaways: number;
  polls: number;
  eventReminders: number;
}

/**
 * Ends giveaways and polls whose delayed job was lost, and sends event reminders that came due during a restart.
 * Drawing and closing are idempotent; event reminders are deduped inside `fireEventReminder`.
 */
export async function catchUpCommunitySchedules(
  ctx: PluginContext,
  now = new Date(),
): Promise<CommunityCatchupResult> {
  const result: CommunityCatchupResult = { giveaways: 0, polls: 0, eventReminders: 0 };

  const giveaways = await ctx.prisma.giveaway.findMany({
    where: { ended: false, endsAt: { lte: now } },
    select: { id: true },
    take: 50,
  });
  for (const giveaway of giveaways) {
    try {
      await finalizeGiveaway(ctx, giveaway.id);
      result.giveaways += 1;
    } catch (err) {
      ctx.logger.error({ err, giveawayId: giveaway.id }, 'community: catch-up could not end a giveaway');
    }
  }

  const polls = await ctx.prisma.poll.findMany({
    where: { closed: false, endsAt: { lte: now } },
    select: { id: true },
    take: 50,
  });
  for (const poll of polls) {
    try {
      await closePoll(ctx, poll.id);
      result.polls += 1;
    } catch (err) {
      ctx.logger.error({ err, pollId: poll.id }, 'community: catch-up could not close a poll');
    }
  }

  const events = await ctx.prisma.communityEvent.findMany({
    where: {
      channelId: { not: null },
      startsAt: { gte: new Date(now.getTime() - REMINDER_GRACE_MS) },
    },
    take: 100,
  });
  for (const event of events) {
    for (const minutes of event.reminderMinutes) {
      const fireAt = event.startsAt.getTime() - minutes * 60_000;
      const lateBy = now.getTime() - fireAt;
      if (lateBy < 0 || lateBy > REMINDER_GRACE_MS) continue;
      try {
        await fireEventReminder(ctx, event.id, minutes);
        result.eventReminders += 1;
      } catch (err) {
        ctx.logger.error(
          { err, eventId: event.id, minutesBefore: minutes },
          'community: catch-up could not send an event reminder',
        );
      }
    }
  }

  return result;
}

/** Every 5 minutes, same cadence as the one-off reminder sweep. */
export const communityCatchupJob: PluginJob<Record<string, never>> = {
  name: 'community-catchup',
  repeat: { pattern: '*/5 * * * *' },
  async processor(ctx) {
    await catchUpCommunitySchedules(ctx);
  },
};
