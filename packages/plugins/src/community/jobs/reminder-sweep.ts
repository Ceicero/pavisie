import type { PluginContext, PluginJob } from '../../sdk';
import { deliverReminder } from '../actions';

async function guildTimezone(ctx: PluginContext, guildId: string | null): Promise<string> {
  if (!guildId) return 'UTC';
  const host = ctx.services.get('host');
  if (!host) return 'UTC';
  try {
    return (await host.getGuildConfig(guildId)).timezone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Catch-up sweep for one-off reminders whose delayed job may have been lost (process restart mid-delay, Redis
 * data loss, etc). Recurring reminders are excluded — their own job scheduler re-fires them independently, so
 * sweeping them here would double-deliver. Runs every 5 minutes (ARCHITECTURE.md community spec).
 */
export const reminderSweepJob: PluginJob<Record<string, never>> = {
  name: 'reminder-sweep',
  repeat: { pattern: '*/5 * * * *' },
  async processor(ctx) {
    const overdue = await ctx.prisma.reminder.findMany({
      where: { delivered: false, recurring: null, remindAt: { lte: new Date() } },
      take: 200,
    });
    for (const reminder of overdue) {
      await deliverReminder(ctx, reminder.id).catch((err) => {
        ctx.logger.error(
          { err, reminderId: reminder.id },
          'community: reminder-sweep failed to deliver a reminder',
        );
      });
    }

    // Recurring reminders are not swept for delivery (that would double-send). If Redis lost their scheduler
    // on restart they would never fire again, and `delivered` stays false so they can be restored here.
    const recurring = await ctx.prisma.reminder.findMany({
      where: { delivered: false, recurring: { not: null } },
      take: 200,
    });
    const queue = ctx.queue('reminder-deliver');
    if (typeof queue.getJobScheduler !== 'function') return;
    for (const reminder of recurring) {
      if (!reminder.recurring) continue;
      try {
        const scheduler = await queue.getJobScheduler(`rem-${reminder.id}`);
        if (scheduler) continue;
        const timezone = await guildTimezone(ctx, reminder.guildId);
        await queue.upsertJobScheduler(
          `rem-${reminder.id}`,
          { pattern: reminder.recurring, tz: timezone },
          { name: 'reminder-deliver', data: { reminderId: reminder.id } },
        );
      } catch (err) {
        ctx.logger.error(
          { err, reminderId: reminder.id },
          'community: reminder-sweep could not restore a recurring scheduler',
        );
      }
    }
  },
};
