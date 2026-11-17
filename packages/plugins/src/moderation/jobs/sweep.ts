import type { PluginJob } from '../../sdk';
import { ModerationServiceImpl } from '../service';
import { liftEnforcerMute } from './enforcer-mute';
import { liftTimeoutForCase } from './expire';

const SWEEP_BATCH = 100;

/**
 * Runs every 5 minutes (ARCHITECTURE.md §7.2/SPEC.md §B): catches TIMEOUT/BAN/timed-ROLE_ADD (enforcer mute)
 * cases whose `delay`-scheduled `expire` job was missed (worker downtime, a Redis flush that dropped the
 * delayed job, etc) by finding any case whose `expiresAt` has already passed but `expiredAt` is still null,
 * and reversing it.
 */
export const sweepJob: PluginJob<Record<string, never>> = {
  name: 'sweep',
  repeat: { pattern: '*/5 * * * *' },
  async processor(ctx) {
    const overdue = await ctx.prisma.moderationCase.findMany({
      where: {
        type: { in: ['TIMEOUT', 'BAN', 'ROLE_ADD'] },
        expiredAt: null,
        deletedAt: null,
        expiresAt: { lte: new Date() },
      },
      take: SWEEP_BATCH,
    });
    if (overdue.length === 0) return;

    const service = new ModerationServiceImpl(ctx);
    for (const row of overdue) {
      try {
        if (row.type === 'TIMEOUT') {
          // Same rule as the expire job: never lift (or keep lifted) a newer timeout given since this case.
          await liftTimeoutForCase(ctx, row, `Timeout expired (case #${row.caseNumber}, caught by sweep)`);
          await ctx.prisma.moderationCase.update({ where: { id: row.id }, data: { expiredAt: new Date() } });
        } else if (row.type === 'ROLE_ADD') {
          // Throws when the mute role could not be removed; the catch below then leaves the case active so
          // the next sweep tries again.
          await liftEnforcerMute(ctx, row, `Mute expired (case #${row.caseNumber}, caught by sweep)`);
          await ctx.prisma.moderationCase.update({ where: { id: row.id }, data: { expiredAt: new Date() } });
        } else {
          await service.unban({
            guildId: row.guildId,
            targetId: row.targetId,
            moderatorId: ctx.client.user.id,
            reason: `Temporary ban expired (case #${row.caseNumber}, caught by sweep)`,
            source: 'SYSTEM',
          });
        }
      } catch (err) {
        ctx.logger.error(
          { err: String(err), caseId: row.id },
          'moderation: sweep job failed to reverse an overdue case',
        );
      }
    }
  },
};
