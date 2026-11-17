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
 * Any other error is rethrown so the case stays active and is retried.
 */
export async function liftTempBan(
  ctx: PluginContext,
  service: ModerationServiceImpl,
  row: BanCaseRow,
  reason: string,
): Promise<LiftTempBanResult> {
  const newer = await ctx.prisma.moderationCase.findFirst({
    where: {
      guildId: row.guildId,
      targetId: row.targetId,
      type: 'BAN',
      expiredAt: null,
      deletedAt: null,
      id: { not: row.id },
      caseNumber: { gt: row.caseNumber },
      OR: row.expiresAt ? [{ expiresAt: null }, { expiresAt: { gt: row.expiresAt } }] : [{ expiresAt: null }],
    },
    select: { id: true, caseNumber: true },
  });
  if (newer) {
    ctx.logger.info(
      { guildId: row.guildId, caseId: row.id, supersededBy: newer.id },
      `moderation: temp ban case #${row.caseNumber} ended without unbanning; case #${newer.caseNumber} is a newer, longer ban`,
    );
    return 'superseded';
  }

  // A ban recorded between the check above and this call would still be lifted. The window is a few ms and
  // the moderator's own ban reply comes after Discord applies it, so this is accepted rather than locked.

  try {
    await service.unban({
      guildId: row.guildId,
      targetId: row.targetId,
      moderatorId: ctx.client.user.id,
      reason,
      source: 'SYSTEM',
    });
    return 'lifted';
  } catch (err) {
    if (discordCode(err) === UNKNOWN_BAN) return 'already-lifted';
    throw err;
  }
}
