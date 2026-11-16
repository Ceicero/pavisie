import type { PluginContext, PluginJob } from '../../sdk';
import {
  RetryableDelivery,
  closePoll,
  finalizeGiveaway,
  fireEventReminder,
  giveawayAnnouncedKey,
  giveawayMessageClosedKey,
  giveawayPendingKey,
} from '../actions';

/** How long after a reminder's fire time a restart may still send it. Later than this, the ping would be stale. */
const REMINDER_GRACE_MS = 15 * 60_000;

/**
 * How long an ended giveaway stays in the catch-up scan. Shorter than the 30-day `giveaway-announced` redis
 * TTL, so a key expiring cannot select the row again and post a second winner message. Ids that threw
 * `RetryableDelivery` also live in the pending set and are not limited to this window.
 */
const GIVEAWAY_CATCHUP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const GIVEAWAY_CATCHUP_SCAN = 200;
const GIVEAWAY_CATCHUP_LIMIT = 50;

export interface CommunityCatchupResult {
  giveaways: number;
  polls: number;
  eventReminders: number;
}

/**
 * Ends giveaways and polls whose delayed job was lost, and sends event reminders that came due during a restart.
 * An ended giveaway whose winner post or ended-message edit did not finish is included too. Drawing and closing
 * are idempotent; event reminders are deduped inside `fireEventReminder`.
 */
export async function catchUpCommunitySchedules(
  ctx: PluginContext,
  now = new Date(),
): Promise<CommunityCatchupResult> {
  const result: CommunityCatchupResult = { giveaways: 0, polls: 0, eventReminders: 0 };

  const windowStart = new Date(now.getTime() - GIVEAWAY_CATCHUP_WINDOW_MS);
  const giveaways = await ctx.prisma.giveaway.findMany({
    where: {
      OR: [
        // Never drawn — including rows whose end time is older than the announcement window.
        { ended: false, endsAt: { lte: now } },
        // Drawn, but the winner post or the edit that drops the Enter button may have failed.
        { ended: true, endsAt: { lte: now, gte: windowStart } },
        // Ended early (endsAt still in the future) or updated by a draw the process didn't finish posting.
        { ended: true, updatedAt: { gte: windowStart } },
      ],
    },
    select: { id: true },
    orderBy: [{ ended: 'asc' }, { endsAt: 'desc' }],
    take: GIVEAWAY_CATCHUP_SCAN,
  });

  const pendingKey = giveawayPendingKey();
  const pending = await ctx.redis.smembers(pendingKey);
  const ordered = [...pending, ...giveaways.map((giveaway) => giveaway.id)];
  const seen = new Set<string>();
  let attempted = 0;

  for (const giveawayId of ordered) {
    if (seen.has(giveawayId)) continue;
    seen.add(giveawayId);

    const [announced, closed] = await Promise.all([
      ctx.redis.get(giveawayAnnouncedKey(giveawayId)),
      ctx.redis.get(giveawayMessageClosedKey(giveawayId)),
    ]);
    if (announced && closed) {
      await ctx.redis.srem(pendingKey, giveawayId);
      continue;
    }
    if (attempted >= GIVEAWAY_CATCHUP_LIMIT) break;
    attempted += 1;

    try {
      await finalizeGiveaway(ctx, giveawayId);
      result.giveaways += 1;
    } catch (err) {
      if (err instanceof RetryableDelivery) {
        ctx.logger.warn({ err, giveawayId }, 'community: giveaway announcement will be retried');
      } else {
        ctx.logger.error({ err, giveawayId }, 'community: catch-up could not end a giveaway');
      }
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
