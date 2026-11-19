import type { PluginContext, PluginJob } from '../../sdk';
import { ModerationServiceImpl } from '../service';
import { liftTempBan, type BanCaseRow } from './ban-expiry';
import { liftEnforcerMute } from './enforcer-mute';
import { liftTimeoutForCase } from './expire';

const SWEEP_BATCH = 100;
/** Upper bound on pages per run, so one run stays bounded even with a large backlog. */
const SWEEP_MAX_PAGES = 10;

interface SweepRow extends BanCaseRow {
  type: string;
  metadata: unknown;
}

async function sweepRow(ctx: PluginContext, service: ModerationServiceImpl, row: SweepRow): Promise<void> {
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
      const result = await liftTempBan(
        ctx,
        service,
        row,
        `Temporary ban expired (case #${row.caseNumber}, caught by sweep)`,
      );
      // unban() already marks BAN cases expired; otherwise only this case is closed.
      if (result !== 'lifted') {
        await ctx.prisma.moderationCase.update({ where: { id: row.id }, data: { expiredAt: new Date() } });
      }
    }
  } catch (err) {
    ctx.logger.error(
      { err: String(err), caseId: row.id },
      'moderation: sweep job failed to reverse an overdue case',
    );
  }
}

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
    const service = new ModerationServiceImpl(ctx);
    const now = new Date();
    let after: { expiresAt: Date; id: string } | undefined;
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      // Oldest first, then keyset paging past the last row seen: rows that keep failing (Missing Permissions, an
      // outage) stay behind the key instead of filling every batch and hiding newer overdue cases.
      const overdue = await ctx.prisma.moderationCase.findMany({
        where: {
          type: { in: ['TIMEOUT', 'BAN', 'ROLE_ADD'] },
          expiredAt: null,
          deletedAt: null,
          expiresAt: { lte: now },
          ...(after
            ? {
                OR: [
                  { expiresAt: { gt: after.expiresAt } },
                  { expiresAt: after.expiresAt, id: { gt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: SWEEP_BATCH,
      });
      for (const row of overdue) {
        await sweepRow(ctx, service, row);
      }
      const last = overdue.at(-1);
      if (overdue.length < SWEEP_BATCH || !last?.expiresAt) return;
      after = { expiresAt: last.expiresAt, id: last.id };
    }
  },
};
