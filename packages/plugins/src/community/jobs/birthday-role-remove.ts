import { fetchMemberSafe, type PluginJob } from '../../sdk';

export interface BirthdayRoleRemoveJobData {
  guildId: string;
  userId: string;
  roleId: string;
}

/**
 * Delayed (~24h) follow-up to `birthday-announce`: removes the birthday role from the member if they still
 * have it. Silently no-ops when the guild/member/role is gone or the bot can no longer manage the role.
 */
export const birthdayRoleRemoveJob: PluginJob<BirthdayRoleRemoveJobData> = {
  name: 'birthday-role-remove',
  async processor(ctx, job) {
    const { guildId, userId, roleId } = job.data;
    const guild =
      ctx.client.guilds.cache.get(guildId) ?? (await ctx.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) return;
    const member = await fetchMemberSafe(guild, userId);
    if (!member || !member.roles.cache.has(roleId)) return;
    try {
      await member.roles.remove(roleId, 'Pavisie community: birthday role expired');
    } catch (err) {
      ctx.logger.warn({ err, guildId, userId, roleId }, 'community: could not remove the birthday role');
    }
  },
};
