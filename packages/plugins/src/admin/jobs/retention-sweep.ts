import { defaultRetentionPolicy, runRetentionForGuild, type RetentionPolicyDays } from '@pavisie/database';
import type { PluginJob } from '../../sdk';

/**
 * Daily repeat job (04:00 UTC) that actually enforces every guild's `DataRetentionPolicy` — the platform-wide
 * counterpart to `@pavisie/database`'s `runRetentionForGuild`, which until this job existed was only ever
 * referenced in comments/docs and never actually scheduled anywhere (docs/PRIVACY_POLICY_TEMPLATE.md §5 claims
 * "a scheduled job... purges records past their retention window automatically"). Lives in `admin` because it's
 * always-loaded and has no plugin-specific ownership of any one target table. Scoped, single-table jobs like
 * `automod:events-retention` and `logging`'s LogEvent purge still run independently — this sweep additionally
 * covers auditLog, moderationCase (soft delete), ticketTranscript, levelProfile, guildAnalyticsDaily, and
 * enforcerRecord (see `RETENTION_TARGETS`).
 */
export const retentionSweepJob: PluginJob = {
  name: 'retention-sweep',
  repeat: { pattern: '0 4 * * *' },
  async processor(ctx) {
    const guilds = await ctx.prisma.guild.findMany({ where: { botPresent: true }, select: { id: true } });

    let guildsProcessed = 0;
    const totals: Record<string, number> = {};

    for (const { id: guildId } of guilds) {
      try {
        const stored = await ctx.prisma.dataRetentionPolicy.findUnique({ where: { guildId } });
        const policy: RetentionPolicyDays = {
          auditLogDays: stored?.auditLogDays ?? defaultRetentionPolicy.auditLogDays,
          logEventDays: stored?.logEventDays ?? defaultRetentionPolicy.logEventDays,
          moderationCaseDays: stored ? stored.moderationCaseDays : defaultRetentionPolicy.moderationCaseDays,
          automodEventDays: stored?.automodEventDays ?? defaultRetentionPolicy.automodEventDays,
          ticketTranscriptDays: stored?.ticketTranscriptDays ?? defaultRetentionPolicy.ticketTranscriptDays,
          levelInactivityDays: stored
            ? stored.levelInactivityDays
            : defaultRetentionPolicy.levelInactivityDays,
          analyticsDays: stored?.analyticsDays ?? defaultRetentionPolicy.analyticsDays,
        };

        const counts = await runRetentionForGuild(ctx.prisma, guildId, policy);
        guildsProcessed += 1;
        for (const [target, count] of Object.entries(counts)) {
          totals[target] = (totals[target] ?? 0) + count;
        }
      } catch (err) {
        // Isolate failures per guild — one guild's bad policy/DB hiccup must not abort the sweep for everyone else.
        ctx.logger.error({ err: String(err), guildId }, 'admin: retention sweep failed for a guild');
      }
    }

    const totalAffected = Object.values(totals).reduce((sum, n) => sum + n, 0);
    if (totalAffected > 0) {
      ctx.logger.info(
        { guildsProcessed, totals },
        'admin: retention sweep purged/soft-deleted records past their retention window',
      );
    }
  },
};
