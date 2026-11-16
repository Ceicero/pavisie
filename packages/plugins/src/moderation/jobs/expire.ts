import type { PluginContext, PluginJob } from '../../sdk';
import { ModerationServiceImpl } from '../service';
import { discordCode, liftEnforcerMute } from './enforcer-mute';

export interface ExpireJobData {
  caseId: string;
}

/**
 * The bot applies a timeout before it writes the case, so the timeout's own end is always at or before the case's
 * `expiresAt`; this only has to absorb clock skew. A member timed out until later than that has been given a newer
 * timeout since, and lifting it would cut that one short.
 */
const TIMEOUT_MATCH_TOLERANCE_MS = 5_000;

/** True when the member's current Discord timeout is the one this TIMEOUT case set (or the case has no end). */
export function timeoutBelongsToCase(
  memberTimeoutEndsAt: number | null,
  caseExpiresAt: Date | null,
): boolean {
  if (!memberTimeoutEndsAt) return false;
  if (!caseExpiresAt) return true;
  return memberTimeoutEndsAt <= caseExpiresAt.getTime() + TIMEOUT_MATCH_TOLERANCE_MS;
}

interface TimeoutCaseRow {
  id: string;
  guildId: string;
  targetId: string;
  caseNumber: number;
  expiresAt: Date | null;
}

/**
 * Lifts the timeout a TIMEOUT case set, unless the member has a newer one. Shared by the expire job and the sweep.
 *
 * A moderator can time the member out again between the member fetch and the lift; that newer timeout would be
 * undone and its own expiry would then find nothing to lift. So after lifting, if a newer TIMEOUT case is still
 * running for the member, its timeout is put back until that case's end.
 */
export async function liftTimeoutForCase(
  ctx: PluginContext,
  row: TimeoutCaseRow,
  reason: string,
): Promise<void> {
  const guild = await ctx.client.guilds.fetch(row.guildId).catch(() => null);
  const member = guild ? await guild.members.fetch(row.targetId).catch(() => null) : null;
  // Member may already be gone (left the server) or the timeout may have already lapsed naturally on Discord's
  // side; either way the caller still marks the case expired.
  if (!member || !timeoutBelongsToCase(member.communicationDisabledUntilTimestamp, row.expiresAt)) return;
  await member.timeout(null, reason).catch(() => undefined);

  const newer = await ctx.prisma.moderationCase.findFirst({
    where: {
      guildId: row.guildId,
      targetId: row.targetId,
      type: 'TIMEOUT',
      expiredAt: null,
      deletedAt: null,
      id: { not: row.id },
      expiresAt: { gt: new Date() },
    },
    orderBy: { expiresAt: 'desc' },
  });
  if (newer?.expiresAt) {
    await member
      .timeout(
        newer.expiresAt.getTime() - Date.now(),
        `A newer timeout (case #${newer.caseNumber}) is still in force`,
      )
      .catch(() => undefined);
  }
}

/** Fires once when a specific TIMEOUT, (temp) BAN, or timed ROLE_ADD (enforcer mute) case's duration elapses (scheduled with `jobId: case-<id>`). */
export const expireJob: PluginJob<ExpireJobData> = {
  name: 'expire',
  async processor(ctx, job) {
    const row = await ctx.prisma.moderationCase.findUnique({ where: { id: job.data.caseId } });
    if (!row || row.expiredAt || row.deletedAt) return;

    const service = new ModerationServiceImpl(ctx);
    // A failed temp-ban lift must leave the case active so the job's retry (or a later run) can try again;
    // only mark it expired once the ban is actually gone.
    let markExpired = true;
    try {
      if (row.type === 'TIMEOUT') {
        await liftTimeoutForCase(ctx, row, `Timeout expired (case #${row.caseNumber})`);
      } else if (row.type === 'BAN') {
        try {
          await service.unban({
            guildId: row.guildId,
            targetId: row.targetId,
            moderatorId: ctx.client.user.id,
            reason: `Temporary ban expired (case #${row.caseNumber})`,
            source: 'SYSTEM',
          });
          return; // unban() already marks BAN cases expired via markExpiredForActiveBan
        } catch (err) {
          // 10026 = Unknown Ban: a moderator already lifted it by hand, so there is nothing left to undo.
          if (discordCode(err) !== 10026) {
            markExpired = false;
            throw err;
          }
        }
      } else if (row.type === 'ROLE_ADD') {
        try {
          await liftEnforcerMute(ctx, row, `Mute expired (case #${row.caseNumber})`);
        } catch (err) {
          // The mute role is still on the member. Leave the case active so the job retry (or the sweep) can
          // lift the mute instead of leaving the member muted indefinitely.
          markExpired = false;
          throw err;
        }
      }
    } finally {
      if (markExpired) {
        await ctx.prisma.moderationCase
          .update({ where: { id: row.id }, data: { expiredAt: new Date() } })
          .catch(() => undefined);
      }
    }
  },
};
