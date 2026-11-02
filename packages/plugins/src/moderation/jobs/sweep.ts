import type { PluginJob } from '../../sdk';
import { ModerationServiceImpl } from '../service';

const SWEEP_BATCH = 100;

/** `metadata.roleId` set by the `enforcer` plugin's timed MUTE (`metadata: { enforcerMute: true, roleId }`). */
function enforcerMuteRoleId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as Record<string, unknown>;
  return m.enforcerMute === true && typeof m.roleId === 'string' ? m.roleId : null;
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
          const guild = await ctx.client.guilds.fetch(row.guildId).catch(() => null);
          const member = guild ? await guild.members.fetch(row.targetId).catch(() => null) : null;
          if (member?.communicationDisabledUntilTimestamp) {
            await member
              .timeout(null, `Timeout expired (case #${row.caseNumber}, caught by sweep)`)
              .catch(() => undefined);
          }
          await ctx.prisma.moderationCase.update({ where: { id: row.id }, data: { expiredAt: new Date() } });
        } else if (row.type === 'ROLE_ADD') {
          const roleId = enforcerMuteRoleId(row.metadata);
          if (roleId) {
            const guild = await ctx.client.guilds.fetch(row.guildId).catch(() => null);
            const member = guild ? await guild.members.fetch(row.targetId).catch(() => null) : null;
            if (member?.roles.cache.has(roleId)) {
              await member.roles
                .remove(roleId, `Mute expired (case #${row.caseNumber}, caught by sweep)`)
                .catch(() => undefined);
            }
          }
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
        ctx.logger.error({ err, caseId: row.id }, 'moderation: sweep job failed to reverse an overdue case');
      }
    }
  },
};
