import { AppError } from '@pavisie/core';
import type { PluginContext } from '../../sdk';
import type { ModerationServiceImpl } from '../service';
import { discordCode } from './enforcer-mute';

const UNKNOWN_BAN = 10026;

export interface BanCaseRow {
  id: string;
  guildId: string;
  targetId: string;
  caseNumber: number;
  expiresAt: Date | null;
}

export type LiftTempBanResult = 'lifted' | 'superseded' | 'already-lifted';

/**
 * Lifts the ban a (temp) BAN case set, unless the member has since been given a permanent or longer ban.
 * Shared by the expire job and the sweep.
 *
 * Only BAN cases recorded after this one (a higher case number in the same guild) count. An older case can still be open after its ban was lifted outside
 * the bot (Discord's own UI), and letting it block this expiry would turn this temp ban into a permanent one.
 *
 * - `superseded`: a newer active BAN case outlives this one, so the Discord ban is left in place. The caller marks
 *   only this case expired.
 * - `already-lifted`: Discord reports Unknown Ban (a moderator removed it by hand). The caller marks this case expired.
 * - `lifted`: the ban was removed; `unban()` has already marked the BAN cases expired.
 *
 * Runs under the member's ban lease (`service.withBanLease`) and re-confirms it right before `unban()`. Any other
 * error, including failing to get or keep the lease, is rethrown so the case stays active and is retried.
 */
export async function liftTempBan(
  ctx: PluginContext,
  service: ModerationServiceImpl,
  row: BanCaseRow,
  reason: string,
): Promise<LiftTempBanResult> {
  // The lease is held across the check and unban() because ban() applies the Discord ban before it writes its case:
  // without it, a moderator's ban landing in that gap would be lifted here. If a ban holds it, this throws and the
  // case stays open for the job retry or the sweep.
  return service.withBanLease(row.guildId, row.targetId, async (lease) => {
    const newer = await ctx.prisma.moderationCase.findFirst({
      where: {
        guildId: row.guildId,
        targetId: row.targetId,
        type: 'BAN',
        expiredAt: null,
        deletedAt: null,
        id: { not: row.id },
        caseNumber: { gt: row.caseNumber },
        OR: row.expiresAt
          ? [{ expiresAt: null }, { expiresAt: { gt: row.expiresAt } }]
          : [{ expiresAt: null }],
      },
      select: { id: true, caseNumber: true },
    });
    if (newer) {
      ctx.logger.info(
        { guildId: row.guildId, caseId: row.id, supersededBy: newer.id },
        `moderation: temp ban case #${row.caseNumber} ended without unbanning; case #${newer.caseNumber} is a newer, longer ban`,
      );
      return 'superseded' as const;
    }

    // The lease is not renewed while the check runs, so a slow check (or a stalled process) can outlive its 30s TTL
    // and a moderator's ban can start in the meantime. Confirm the lease is still ours, and reset its TTL for the
    // unban call, before lifting anything; otherwise leave the case open for the job retry or the sweep.
    if (!(await lease.renew())) {
      throw new AppError(
        'ban_lease_lost',
        `Temp ban case #${row.caseNumber} not lifted: its ban lease was lost (expired or taken by another ban) before the unban. It will be retried.`,
        { status: 409 },
      );
    }

    try {
      await service.unban({
        guildId: row.guildId,
        targetId: row.targetId,
        moderatorId: ctx.client.user.id,
        reason,
        source: 'SYSTEM',
      });
      return 'lifted' as const;
    } catch (err) {
      if (discordCode(err) === UNKNOWN_BAN) return 'already-lifted' as const;
      throw err;
    }
  });
}
