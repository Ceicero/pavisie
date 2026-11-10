import type { PluginJob } from '../../sdk';
import { ModerationServiceImpl } from '../service';
import { liftEnforcerMute } from './enforcer-mute';

export interface ExpireJobData {
  caseId: string;
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
        const guild = await ctx.client.guilds.fetch(row.guildId).catch(() => null);
        const member = guild ? await guild.members.fetch(row.targetId).catch(() => null) : null;
        // Member may already be gone (left the server) or the timeout may have already lapsed naturally on
        // Discord's side — either way, the case's expiredAt still needs to be marked below.
        if (member?.communicationDisabledUntilTimestamp) {
          await member.timeout(null, `Timeout expired (case #${row.caseNumber})`).catch(() => undefined);
        }
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
          if ((err as { code?: unknown })?.code !== 10026) {
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
