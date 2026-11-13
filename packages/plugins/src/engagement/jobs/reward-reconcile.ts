import { fetchMemberSafe, type PluginContext, type PluginJob } from '../../sdk';
import type { EngagementConfig } from '../manifest';
import { REWARD_ROLE_SYNC_LIMIT, syncMemberRewardRoles } from '../level-actions';
import { rewardReconcileListKey, type RewardReconcileEntry } from '../reward-queue';

/**
 * Drains the reward-reconcile Redis list and recomputes each member's reward roles for their stored
 * level (level 0 when the profile row is already gone, which is how a reset removes roles).
 *
 * The host only schedules plugin jobs that set `repeat`, and the API cannot edit Discord roles itself,
 * so this polls once a minute. One tick writes roles for at most `REWARD_ROLE_SYNC_LIMIT` members — the
 * same cap as `/level rewards sync` — and leaves the rest of the list for the next minute.
 */
export const rewardReconcileJob: PluginJob = {
  name: 'reward-reconcile',
  repeat: { pattern: '* * * * *' },
  async processor(ctx) {
    const key = rewardReconcileListKey();
    for (let n = 0; n < REWARD_ROLE_SYNC_LIMIT; n += 1) {
      const raw = await ctx.redis.lpop(key);
      if (raw == null) return;
      const entry = parseEntry(typeof raw === 'string' ? raw : String(raw));
      if (!entry) {
        ctx.logger.warn('engagement: dropping a malformed reward-reconcile entry');
        continue;
      }
      try {
        await reconcileEntry(ctx, entry);
      } catch (err) {
        ctx.logger.warn(
          {
            guildId: entry.guildId,
            userId: entry.userId,
            err: err instanceof Error ? err.message : String(err),
          },
          'engagement: reward reconcile failed for one member',
        );
      }
    }
  },
};

function parseEntry(raw: string): RewardReconcileEntry | null {
  try {
    const value = JSON.parse(raw) as Partial<RewardReconcileEntry>;
    if (typeof value.guildId !== 'string' || typeof value.userId !== 'string') return null;
    if (value.guildId.length === 0 || value.userId.length === 0) return null;
    return { guildId: value.guildId, userId: value.userId };
  } catch {
    return null;
  }
}

async function reconcileEntry(ctx: PluginContext, entry: RewardReconcileEntry): Promise<void> {
  const guild = await ctx.client.guilds.fetch(entry.guildId).catch(() => null);
  if (!guild) return;
  const member = await fetchMemberSafe(guild, entry.userId);
  if (!member) return;

  const [config, profile] = await Promise.all([
    ctx.getConfig<EngagementConfig>(entry.guildId),
    ctx.prisma.levelProfile.findUnique({
      where: { guildId_userId: { guildId: entry.guildId, userId: entry.userId } },
    }),
  ]);

  await syncMemberRewardRoles({
    ctx,
    guildId: entry.guildId,
    member,
    level: profile?.level ?? 0,
    mode: config.leveling.rewardMode,
  });
}
