import { defaultRetentionPolicy } from '@pavisie/database';
import type { PluginJob } from '../../sdk';

const DEFAULT_AUTOMOD_EVENT_DAYS = defaultRetentionPolicy.automodEventDays;

/**
 * Hourly repeat job (TASK: "a repeat job 'automod:events-retention' hourly (purge AutomodEvent older than
 * DataRetentionPolicy.automodEventDays)"). Scoped to `AutomodEvent` only — the platform-wide retention sweep
 * across every table (`@pavisie/database`'s `runRetentionForGuild`) is out of this plugin's ownership; this job
 * exists so automod's own event log respects each guild's retention setting even before that sweep lands.
 */
export const eventsRetentionJob: PluginJob = {
  name: 'events-retention',
  repeat: { pattern: '0 * * * *' },
  async processor(ctx) {
    const guildIds = await ctx.prisma.automodEvent.findMany({
      distinct: ['guildId'],
      select: { guildId: true },
    });

    let totalDeleted = 0;
    for (const { guildId } of guildIds) {
      const policy = await ctx.prisma.dataRetentionPolicy.findUnique({ where: { guildId } });
      const days = policy?.automodEventDays ?? DEFAULT_AUTOMOD_EVENT_DAYS;
      if (days === null || days === undefined) continue;

      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const result = await ctx.prisma.automodEvent.deleteMany({
        where: { guildId, createdAt: { lt: cutoff } },
      });
      totalDeleted += result.count;
    }

    if (totalDeleted > 0) {
      ctx.logger.info({ deleted: totalDeleted }, 'automod: retention sweep purged old AutomodEvent rows');
    }
  },
};
