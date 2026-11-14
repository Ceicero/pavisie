// Incident lifecycle: start, periodic flush, end, lockdown and restore — and their audit rows.
//
// Every state change and its audit row are written in one transaction (the #34 pattern), so neither can exist
// without the other. Discord calls happen outside the transaction: lockdown and restore act on Discord first and
// record what actually happened.
import { randomUUID } from 'node:crypto';
import type { Guild, GuildMember } from 'discord.js';
import { AuditAction } from '@pavisie/core';
import { writeAudit, type Prisma, type RaidModeIncident } from '@pavisie/database';
import { resolveTextChannel, type PluginContext, type PluginJob } from '../sdk';
import { incidentButtons, incidentEmbed, reminderText } from './alert';
import { applyLockdown, restoreChanges } from './lockdown';
import type { RaidModeConfig } from './manifest';
import { HIGH_RISK_SCORE, scoreJoin, type RiskReason } from './scoring';
import { claimIncident, drainIncident, recordJoin, releaseIncident, withIncidentLease } from './state';

const HOUR = 3_600_000;
export const UPDATE_INTERVAL_MS = 5_000;
export const UPDATE_JOB_NAME = 'update';
export const UPDATE_JOB_ATTEMPTS = 5;

export interface UpdateJobData {
  guildId: string;
  incidentId: string;
  tick: number;
}

/** A queued score, as pushed to Redis by the join path. Member id, score and reason codes only. */
interface QueuedScore {
  u: string;
  s: number;
  r: RiskReason[];
  j: number;
}

function botId(ctx: PluginContext): string {
  return ctx.client.user?.id ?? 'raidmode';
}

// ---------------------------------------------------------------------------------------------------------
// Join path
// ---------------------------------------------------------------------------------------------------------

/** True when this window looks like a raid under the server's own thresholds. */
export function crossesThreshold(config: RaidModeConfig, windowTotal: number, windowNew: number): boolean {
  if (windowTotal < config.joinThreshold) return false;
  return windowNew * 100 >= config.newAccountSharePct * windowTotal;
}

export async function handleJoin(ctx: PluginContext, member: GuildMember): Promise<void> {
  if (member.user.bot) return;
  const config = await ctx.getConfig<RaidModeConfig>(member.guild.id);
  const now = Date.now();
  const joinedAt = new Date(now);
  const accountCreatedAt = member.user.createdAt;
  const risk = scoreJoin({
    accountCreatedAt,
    joinedAt,
    hasCustomAvatar: member.user.avatar !== null,
    username: member.user.username,
    flaggedSpammer: member.user.flags?.has('Spammer') ?? false,
  });
  const isNewAccount = now - accountCreatedAt.getTime() < config.newAccountMaxAgeHours * HOUR;
  const payload: QueuedScore | null =
    risk.level === 'low' ? null : { u: member.id, s: risk.score, r: risk.reasons, j: now };

  const record = await recordJoin(ctx, member.guild.id, {
    now,
    windowMs: config.windowSeconds * 1000,
    isNewAccount,
    level: risk.level,
    scorePayload: payload ? JSON.stringify(payload) : '',
  });
  if (record.activeIncidentId) return;
  if (!crossesThreshold(config, record.windowTotal, record.windowNew)) return;
  await startIncident(ctx, member.guild, config, record.windowTotal, record.windowNew, now);
}

// ---------------------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------------------

async function startIncident(
  ctx: PluginContext,
  guild: Guild,
  config: RaidModeConfig,
  windowTotal: number,
  windowNew: number,
  now: number,
): Promise<void> {
  const incidentId = randomUUID();
  // Atomic: two joins crossing the threshold at the same moment start one incident.
  if (
    !(await claimIncident(ctx, guild.id, incidentId, { joins: windowTotal, newAccounts: windowNew, now }))
  ) {
    return;
  }
  const thresholds = {
    joins: config.joinThreshold,
    windowSeconds: config.windowSeconds,
    accountAgeHours: config.newAccountMaxAgeHours,
    newAccountSharePct: config.newAccountSharePct,
  };
  let incident: RaidModeIncident;
  try {
    incident = await ctx.prisma.$transaction(async (tx) => {
      const created = await tx.raidModeIncident.create({
        data: {
          id: incidentId,
          guildId: guild.id,
          dryRun: config.dryRun,
          startedAt: new Date(now),
          lastJoinAt: new Date(now),
          joinsTotal: windowTotal,
          joinsFlagged: windowNew,
          thresholds,
        },
      });
      await writeAudit(tx, {
        guildId: guild.id,
        actorId: botId(ctx),
        actorType: 'system',
        action: AuditAction.RaidModeIncidentStart,
        targetType: 'raidmode_incident',
        targetId: created.id,
        after: {
          thresholds,
          joinsInWindow: windowTotal,
          newAccountsInWindow: windowNew,
          dryRun: config.dryRun,
        },
        source: 'system',
      });
      return created;
    });
  } catch (err) {
    // Give the slot back so the next join can try again, instead of leaving a phantom incident in Redis.
    await releaseIncident(ctx, guild.id, incidentId).catch(() => undefined);
    throw err;
  }

  await scheduleUpdate(ctx, { guildId: guild.id, incidentId, tick: 1 }).catch((err: unknown) =>
    ctx.logger.error(
      { guildId: guild.id, incidentId, err: err instanceof Error ? err.message : String(err) },
      'raidmode: could not schedule incident updates',
    ),
  );
  await postAlert(ctx, guild, config, incident);
  if (!config.dryRun) {
    await lockdownIncident(ctx, guild, incidentId, 'auto');
  }
}

async function postAlert(
  ctx: PluginContext,
  guild: Guild,
  config: RaidModeConfig,
  incident: RaidModeIncident,
): Promise<void> {
  if (!config.alertChannelId) {
    ctx.logger.warn({ guildId: guild.id }, 'raidmode: no alert channel configured; incident recorded only');
    return;
  }
  const channel = await resolveTextChannel(guild, config.alertChannelId);
  if (!channel) {
    ctx.logger.warn({ guildId: guild.id }, 'raidmode: cannot post to the configured alert channel');
    return;
  }
  try {
    const message = await channel.send({
      embeds: [incidentEmbed(incident)],
      components: incidentButtons(incident),
      allowedMentions: { parse: [] },
    });
    await ctx.prisma.raidModeIncident.update({
      where: { id: incident.id },
      data: { alertChannelId: channel.id, alertMessageId: message.id },
    });
  } catch (err) {
    ctx.logger.warn(
      { guildId: guild.id, err: err instanceof Error ? err.message : String(err) },
      'raidmode: failed to post the raid alert',
    );
  }
}

/** Re-renders the alert from the incident's current row. Best-effort. */
export async function refreshAlert(
  ctx: PluginContext,
  guild: Guild,
  incident: RaidModeIncident,
): Promise<void> {
  if (!incident.alertChannelId || !incident.alertMessageId) return;
  try {
    const channel = await resolveTextChannel(guild, incident.alertChannelId);
    if (!channel) return;
    await channel.messages.edit(incident.alertMessageId, {
      embeds: [incidentEmbed(incident)],
      components: incidentButtons(incident),
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    ctx.logger.warn(
      { guildId: guild.id, err: err instanceof Error ? err.message : String(err) },
      'raidmode: failed to update the raid alert',
    );
  }
}

// ---------------------------------------------------------------------------------------------------------
// Periodic flush and end
// ---------------------------------------------------------------------------------------------------------

async function scheduleUpdate(ctx: PluginContext, data: UpdateJobData): Promise<void> {
  await ctx.queue(UPDATE_JOB_NAME).add(UPDATE_JOB_NAME, data, {
    jobId: `raidmode-${data.incidentId}-${data.tick}`,
    delay: UPDATE_INTERVAL_MS,
    attempts: UPDATE_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  });
}

function parseQueuedScores(payloads: string[]): QueuedScore[] {
  const out: QueuedScore[] = [];
  for (const raw of payloads) {
    try {
      const v = JSON.parse(raw) as Partial<QueuedScore>;
      if (
        typeof v.u === 'string' &&
        typeof v.s === 'number' &&
        Array.isArray(v.r) &&
        typeof v.j === 'number'
      ) {
        out.push({ u: v.u, s: v.s, r: v.r.filter((r): r is RiskReason => typeof r === 'string'), j: v.j });
      }
    } catch {
      // A malformed entry is dropped; it only ever held a member id and a score.
    }
  }
  return out;
}

/**
 * Moves the incident's Redis counters and queued scores into the database, ends the incident once it has gone
 * quiet, and keeps the alert current. Re-queues itself until the incident ends.
 */
export const updateJob: PluginJob<UpdateJobData> = {
  name: UPDATE_JOB_NAME,
  concurrency: 5,
  async processor(ctx, job) {
    const { guildId, incidentId, tick } = job.data;
    const existing = await ctx.prisma.raidModeIncident.findUnique({ where: { id: incidentId } });
    if (!existing || existing.status === 'ENDED') return;
    const config = await ctx.getConfig<RaidModeConfig>(guildId);
    const now = Date.now();
    const drain = await drainIncident(ctx, guildId, incidentId, now, config.quietMinutes * 60_000);
    // Redis lost the incident (expired, flushed): end it with what the database already has.
    const ending = drain.closed || !drain.current;
    const scores = parseQueuedScores(drain.scorePayloads);

    const incident = await ctx.prisma.$transaction(async (tx) => {
      const data: Prisma.RaidModeIncidentUpdateInput = {};
      if (drain.current) {
        data.joinsTotal = drain.counters.joins;
        data.joinsFlagged = drain.counters.flagged;
        data.riskLow = drain.counters.low;
        data.riskMedium = drain.counters.medium;
        data.riskHigh = drain.counters.high;
        if (drain.counters.lastJoinAt > 0) data.lastJoinAt = new Date(drain.counters.lastJoinAt);
      }
      if (ending) {
        data.status = 'ENDED';
        data.endedAt = new Date(now);
      }
      if (scores.length > 0) {
        await tx.raidModeRiskScore.createMany({
          data: scores.map((s) => ({
            incidentId,
            guildId,
            userId: s.u,
            score: s.s,
            reasons: s.r,
            joinedAt: new Date(s.j),
          })),
          skipDuplicates: true,
        });
        await writeAudit(tx, {
          guildId,
          actorId: botId(ctx),
          actorType: 'system',
          action: AuditAction.RaidModeScoresRecord,
          targetType: 'raidmode_incident',
          targetId: incidentId,
          // Counts only: the audit log never lists the scored members.
          after: {
            recorded: scores.length,
            high: scores.filter((s) => s.s >= HIGH_RISK_SCORE).length,
            medium: scores.filter((s) => s.s < HIGH_RISK_SCORE).length,
          },
          source: 'system',
        });
      }
      const updated = await tx.raidModeIncident.update({ where: { id: incidentId }, data });
      if (ending) {
        await writeAudit(tx, {
          guildId,
          actorId: botId(ctx),
          actorType: 'system',
          action: AuditAction.RaidModeIncidentEnd,
          targetType: 'raidmode_incident',
          targetId: incidentId,
          after: {
            joins: updated.joinsTotal,
            flagged: updated.joinsFlagged,
            risk: { low: updated.riskLow, medium: updated.riskMedium, high: updated.riskHigh },
            lockdownState: updated.lockdownState,
          },
          source: 'system',
        });
      }
      return updated;
    });

    const guild =
      ctx.client.guilds.cache.get(guildId) ?? (await ctx.client.guilds.fetch(guildId).catch(() => null));
    if (guild) {
      await refreshAlert(ctx, guild, incident);
      if (ending) await remindIfStillLocked(ctx, guild, config, incident);
    }
    if (!ending) await scheduleUpdate(ctx, { guildId, incidentId, tick: tick + 1 });
  },
};

/** Once the raid is over, tell staff (once) if the lockdown is still on. It is never lifted automatically. */
async function remindIfStillLocked(
  ctx: PluginContext,
  guild: Guild,
  config: RaidModeConfig,
  incident: RaidModeIncident,
): Promise<void> {
  const locked = incident.lockdownState === 'LOCKED' || incident.lockdownState === 'PARTIALLY_RESTORED';
  if (!locked || incident.reminderSentAt) return;
  const channelId = incident.alertChannelId ?? config.alertChannelId;
  if (!channelId) return;
  const channel = await resolveTextChannel(guild, channelId);
  if (!channel) return;
  try {
    await channel.send({
      content: reminderText(incident),
      components: incidentButtons(incident),
      allowedMentions: { parse: [] },
    });
    await ctx.prisma.raidModeIncident.update({
      where: { id: incident.id },
      data: { reminderSentAt: new Date() },
    });
  } catch (err) {
    ctx.logger.warn(
      { guildId: guild.id, err: err instanceof Error ? err.message : String(err) },
      'raidmode: failed to post the lockdown reminder',
    );
  }
}

// ---------------------------------------------------------------------------------------------------------
// Lockdown and restore
// ---------------------------------------------------------------------------------------------------------

export type LockdownOutcome =
  | { status: 'locked'; incident: RaidModeIncident; channelsLocked: number; failures: number }
  | { status: 'already_locked' | 'nothing_to_lock' | 'busy' | 'not_found' };

export async function lockdownIncident(
  ctx: PluginContext,
  guild: Guild,
  incidentId: string,
  actor: 'auto' | string,
): Promise<LockdownOutcome> {
  const outcome = await withIncidentLease(ctx, incidentId, async (): Promise<LockdownOutcome> => {
    const incident = await ctx.prisma.raidModeIncident.findUnique({ where: { id: incidentId } });
    if (!incident || incident.guildId !== guild.id) return { status: 'not_found' };
    if (incident.lockdownState === 'LOCKED' || incident.lockdownState === 'PARTIALLY_RESTORED') {
      return { status: 'already_locked' };
    }
    const config = await ctx.getConfig<RaidModeConfig>(guild.id);
    const reason = `Raid mode lockdown (${actor === 'auto' ? 'automatic' : `by ${actor}`})`;
    const result = await applyLockdown(ctx, guild, config, incidentId, reason);
    if (result.actions.length === 0) return { status: 'nothing_to_lock' };

    const updated = await ctx.prisma.$transaction(async (tx) => {
      const row = await tx.raidModeIncident.update({
        where: { id: incidentId },
        data: {
          lockdownState: 'LOCKED',
          lockdownActions: result.actions,
          lockdownAppliedAt: new Date(),
          lockdownAppliedBy: actor,
          lockdownRestoredAt: null,
          lockdownRestoredBy: null,
          reminderSentAt: null,
        },
      });
      await writeAudit(tx, {
        guildId: guild.id,
        actorId: actor === 'auto' ? botId(ctx) : actor,
        actorType: actor === 'auto' ? 'system' : 'user',
        action: AuditAction.RaidModeLockdownApply,
        targetType: 'raidmode_incident',
        targetId: incidentId,
        after: {
          actions: result.actions,
          channelsLocked: result.channelsLocked,
          channelsAlreadyClosed: result.channelsAlreadyClosed,
          failures: result.failures,
        },
        source: actor === 'auto' ? 'system' : 'bot',
      });
      return row;
    });
    await refreshAlert(ctx, guild, updated);
    return {
      status: 'locked',
      incident: updated,
      channelsLocked: result.channelsLocked,
      failures: result.failures,
    };
  });
  return outcome === 'busy' ? { status: 'busy' } : outcome;
}

export type RestoreOutcome =
  | {
      status: 'restored' | 'partially_restored';
      incident: RaidModeIncident;
      restored: number;
      skipped: { channelId: string | null; kind: string; reason: string }[];
      failed: number;
    }
  | { status: 'not_locked' | 'busy' | 'not_found' };

export async function restoreIncident(
  ctx: PluginContext,
  guild: Guild,
  incidentId: string,
  actorId: string,
): Promise<RestoreOutcome> {
  const outcome = await withIncidentLease(ctx, incidentId, async (): Promise<RestoreOutcome> => {
    const incident = await ctx.prisma.raidModeIncident.findUnique({ where: { id: incidentId } });
    if (!incident || incident.guildId !== guild.id) return { status: 'not_found' };
    if (incident.lockdownState !== 'LOCKED' && incident.lockdownState !== 'PARTIALLY_RESTORED') {
      return { status: 'not_locked' };
    }
    const changes = await ctx.prisma.raidModeLockdownChange.findMany({
      where: { incidentId, restoreSkippedReason: null },
    });
    const result = await restoreChanges(ctx, guild, changes, `Raid mode restore by ${actorId}`);
    const state = result.failedIds.length > 0 ? 'PARTIALLY_RESTORED' : 'RESTORED';
    const skipped = result.skipped.map(({ channelId, kind, reason }) => ({ channelId, kind, reason }));

    const updated = await ctx.prisma.$transaction(async (tx) => {
      if (result.restoredIds.length > 0) {
        await tx.raidModeLockdownChange.deleteMany({ where: { id: { in: result.restoredIds } } });
      }
      for (const s of result.skipped) {
        await tx.raidModeLockdownChange.update({
          where: { id: s.id },
          data: { restoreSkippedReason: s.reason },
        });
      }
      const row = await tx.raidModeIncident.update({
        where: { id: incidentId },
        data: { lockdownState: state, lockdownRestoredAt: new Date(), lockdownRestoredBy: actorId },
      });
      await writeAudit(tx, {
        guildId: guild.id,
        actorId,
        actorType: 'user',
        action: AuditAction.RaidModeLockdownRestore,
        targetType: 'raidmode_incident',
        targetId: incidentId,
        after: { restored: result.restoredIds.length, skipped, failed: result.failedIds.length, state },
        source: 'bot',
      });
      return row;
    });
    await refreshAlert(ctx, guild, updated);
    return {
      status: state === 'RESTORED' ? 'restored' : 'partially_restored',
      incident: updated,
      restored: result.restoredIds.length,
      skipped,
      failed: result.failedIds.length,
    };
  });
  return outcome === 'busy' ? { status: 'busy' } : outcome;
}

// ---------------------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------------------

export const SCORE_RETENTION_DAYS = 30;

/** Daily: deletes risk scores from incidents that ended more than 30 days ago, one audit row per server. */
export const purgeJob: PluginJob<Record<string, never>> = {
  name: 'purge-scores',
  repeat: { pattern: '23 4 * * *' },
  async processor(ctx) {
    const cutoff = new Date(Date.now() - SCORE_RETENTION_DAYS * 24 * HOUR);
    const old = await ctx.prisma.raidModeIncident.findMany({
      where: { status: 'ENDED', endedAt: { lt: cutoff }, scores: { some: {} } },
      select: { id: true, guildId: true },
      take: 500,
    });
    const byGuild = new Map<string, string[]>();
    for (const row of old) byGuild.set(row.guildId, [...(byGuild.get(row.guildId) ?? []), row.id]);
    for (const [guildId, incidentIds] of byGuild) {
      await ctx.prisma.$transaction(async (tx) => {
        const deleted = await tx.raidModeRiskScore.deleteMany({ where: { incidentId: { in: incidentIds } } });
        await writeAudit(tx, {
          guildId,
          actorId: botId(ctx),
          actorType: 'system',
          action: AuditAction.RaidModeScoresPurge,
          targetType: 'raidmode_scores',
          after: {
            deleted: deleted.count,
            incidents: incidentIds.length,
            retentionDays: SCORE_RETENTION_DAYS,
          },
          source: 'system',
        });
      });
    }
  },
};

/** The guild's most recent incident, for `/raidmode`. */
export function latestIncident(ctx: PluginContext, guildId: string): Promise<RaidModeIncident | null> {
  return ctx.prisma.raidModeIncident.findFirst({ where: { guildId }, orderBy: { startedAt: 'desc' } });
}
