import type { GuildMember } from 'discord.js';
import { discordErrorCode, type PluginContext, type PluginJob } from '../../sdk';
import type { EngagementConfig } from '../manifest';
import { REWARD_ROLE_SYNC_LIMIT, syncMemberRewardRoles } from '../level-actions';
import {
  enqueueRewardReconcile,
  rewardReconcileBackoffMs,
  rewardReconcileListKey,
  REWARD_RECONCILE_MAX_ATTEMPTS,
  type RewardReconcileEntry,
} from '../reward-queue';

/**
 * Drains the reward-reconcile Redis list and recomputes each member's reward roles for their stored
 * level (level 0 when the profile row is already gone, which is how a reset removes roles).
 *
 * The host only schedules plugin jobs that set `repeat`, and the API cannot edit Discord roles itself,
 * so this polls once a minute. One tick writes roles for at most `REWARD_ROLE_SYNC_LIMIT` members — the
 * same cap as `/level rewards sync` — and leaves the rest of the list for the next minute.
 *
 * A thrown role sync, or any other error that is not permanent, is appended again with `attempts` and
 * `notBefore` (BullMQ exponential backoff, one minute then two). An entry whose `notBefore` is still
 * ahead — including a reset entry held for 30s so the profile delete can finish — is put back without
 * a role write. Unknown member / unknown guild are dropped quietly. Missing permissions is logged once
 * and dropped. The third failure is logged once and dropped.
 */
export const rewardReconcileJob: PluginJob = {
  name: 'reward-reconcile',
  repeat: { pattern: '* * * * *' },
  async processor(ctx) {
    const key = rewardReconcileListKey();
    const again: RewardReconcileEntry[] = [];
    for (let n = 0; n < REWARD_ROLE_SYNC_LIMIT; n += 1) {
      const raw = await ctx.redis.lpop(key);
      if (raw == null) break;
      const entry = parseEntry(typeof raw === 'string' ? raw : String(raw));
      if (!entry) {
        ctx.logger.warn('engagement: dropping a malformed reward-reconcile entry');
        continue;
      }
      if ((entry.attempts ?? 0) >= REWARD_RECONCILE_MAX_ATTEMPTS) {
        logDropped(ctx, entry, entry.attempts ?? REWARD_RECONCILE_MAX_ATTEMPTS);
        continue;
      }
      if (entry.notBefore != null && entry.notBefore > Date.now()) {
        again.push(entry);
        continue;
      }
      try {
        await reconcileEntry(ctx, entry);
      } catch (err) {
        if (isPermanentReconcileError(err)) {
          if (!isDepartedTarget(err)) {
            ctx.logger.warn(
              {
                guildId: entry.guildId,
                userId: entry.userId,
                err: errorMessage(err),
              },
              'engagement: reward reconcile skipped (missing permissions)',
            );
          }
          continue;
        }
        const attemptsMade = (entry.attempts ?? 0) + 1;
        if (attemptsMade >= REWARD_RECONCILE_MAX_ATTEMPTS) {
          logDropped(ctx, entry, attemptsMade, err);
          continue;
        }
        ctx.logger.debug(
          { guildId: entry.guildId, userId: entry.userId, attempts: attemptsMade, err: errorMessage(err) },
          'engagement: reward reconcile will retry',
        );
        again.push({
          guildId: entry.guildId,
          userId: entry.userId,
          attempts: attemptsMade,
          notBefore: Date.now() + rewardReconcileBackoffMs(attemptsMade),
        });
      }
    }
    await enqueueRewardReconcile(ctx.redis, again);
  },
};

const UNKNOWN_GUILD = 10004;
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_USER = 10013;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDepartedTarget(err: unknown): boolean {
  const code = discordErrorCode(err);
  if (code === UNKNOWN_GUILD || code === UNKNOWN_MEMBER || code === UNKNOWN_USER) return true;
  return /unknown member|unknown guild|unknown user/i.test(errorMessage(err));
}

/** Unknown member and missing permissions cannot succeed on another try. Anything else can. */
function isPermanentReconcileError(err: unknown): boolean {
  if (isDepartedTarget(err)) return true;
  const code = discordErrorCode(err);
  if (code === MISSING_ACCESS || code === MISSING_PERMISSIONS) return true;
  return /missing permissions|missing access/i.test(errorMessage(err));
}

function logDropped(ctx: PluginContext, entry: RewardReconcileEntry, attempts: number, err?: unknown): void {
  ctx.logger.warn(
    {
      guildId: entry.guildId,
      userId: entry.userId,
      attempts,
      ...(err !== undefined ? { err: errorMessage(err) } : {}),
    },
    'engagement: dropping reward reconcile entry after retries',
  );
}

function parseEntry(raw: string): RewardReconcileEntry | null {
  try {
    const value = JSON.parse(raw) as Partial<RewardReconcileEntry>;
    if (typeof value.guildId !== 'string' || typeof value.userId !== 'string') return null;
    if (value.guildId.length === 0 || value.userId.length === 0) return null;
    let attempts: number | undefined;
    if (value.attempts !== undefined) {
      if (typeof value.attempts !== 'number' || !Number.isInteger(value.attempts) || value.attempts < 0) {
        return null;
      }
      attempts = value.attempts;
    }
    let notBefore: number | undefined;
    if (value.notBefore !== undefined) {
      if (typeof value.notBefore !== 'number' || !Number.isFinite(value.notBefore)) return null;
      notBefore = value.notBefore;
    }
    return {
      guildId: value.guildId,
      userId: value.userId,
      ...(attempts !== undefined ? { attempts } : {}),
      ...(notBefore !== undefined ? { notBefore } : {}),
    };
  } catch {
    return null;
  }
}

interface RoleWrites {
  roles: {
    add: (...args: unknown[]) => Promise<unknown>;
    remove: (...args: unknown[]) => Promise<unknown>;
  };
}

/**
 * `syncMemberRewardRoles` logs and swallows role-write failures. Capture the rejection so this job
 * can tell a missing-permissions error from one that should be tried again.
 */
function trackRoleWriteErrors(member: RoleWrites, bucket: { error?: unknown }): void {
  const add = member.roles.add.bind(member.roles);
  const remove = member.roles.remove.bind(member.roles);
  member.roles.add = async (...args: unknown[]) => {
    try {
      return await add(...args);
    } catch (err) {
      bucket.error = err;
      throw err;
    }
  };
  member.roles.remove = async (...args: unknown[]) => {
    try {
      return await remove(...args);
    } catch (err) {
      bucket.error = err;
      throw err;
    }
  };
}

function withoutRewardSyncWarning(ctx: PluginContext): PluginContext {
  const logger = Object.create(ctx.logger) as PluginContext['logger'];
  logger.warn = (() => undefined) as PluginContext['logger']['warn'];
  return Object.assign(Object.create(ctx) as PluginContext, { logger });
}

async function reconcileEntry(ctx: PluginContext, entry: RewardReconcileEntry): Promise<void> {
  const guild = await ctx.client.guilds.fetch(entry.guildId);
  if (!guild) return;
  const member = await guild.members.fetch(entry.userId);
  if (!member) return;

  const [config, profile] = await Promise.all([
    ctx.getConfig<EngagementConfig>(entry.guildId),
    ctx.prisma.levelProfile.findUnique({
      where: { guildId_userId: { guildId: entry.guildId, userId: entry.userId } },
    }),
  ]);

  const bucket: { error?: unknown } = {};
  trackRoleWriteErrors(member as unknown as RoleWrites, bucket);
  await syncMemberRewardRoles({
    ctx: withoutRewardSyncWarning(ctx),
    guildId: entry.guildId,
    member: member as GuildMember,
    level: profile?.level ?? 0,
    mode: config.leveling.rewardMode,
  });
  if (bucket.error !== undefined) throw bucket.error;
}
