import type { PluginJob } from '../../sdk';
import { getLoggingServiceInstance } from '../service';

/**
 * Daily repeat job `logging:retention` (ARCHITECTURE.md's logging task): purges each guild's `LogEvent` rows
 * older than `min(config.retentionDays, DataRetentionPolicy.logEventDays)`. Runs across every guild the bot is
 * currently in, regardless of whether `logging` is enabled there — purging old rows for a guild that later
 * re-enables the plugin is still correct behavior, and a disabled plugin simply isn't producing new rows to purge.
 */
export const retentionJob: PluginJob = {
  name: 'retention',
  repeat: { pattern: '0 3 * * *' }, // daily at 03:00 UTC
  async processor(ctx) {
    const logging = getLoggingServiceInstance();
    if (!logging) return;

    const guilds = await ctx.prisma.guild.findMany({ where: { botPresent: true }, select: { id: true } });
    let totalPurged = 0;

    for (const { id: guildId } of guilds) {
      try {
        totalPurged += await logging.purgeRetention(guildId);
      } catch (err) {
        ctx.logger.error({ guildId, err }, 'logging: retention purge failed for a guild');
      }
    }

    ctx.logger.info({ guildCount: guilds.length, totalPurged }, 'logging: retention sweep complete');
  },
};
