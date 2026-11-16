// Incident lifecycle: start, periodic flush, end, lockdown and restore — and their audit rows.
//
// Every state change and its audit row are written in one transaction (the #34 pattern), so neither can exist
// without the other. Discord calls happen outside the transaction: lockdown and restore act on Discord first and
// record what actually happened.
//
// Crash safety for lockdown: the incident is marked LOCKING *before* the first Discord edit, and each change row
// is saved before its edit. Restore works from the outstanding change rows whatever the incident's state says,
// so a restart (or a failed final write) part-way through a lockdown never strands locked channels.
import { randomUUID } from 'node:crypto';
import type { Guild, GuildMember } from 'discord.js';
import { AuditAction } from '@pavisie/core';
import {
  writeAudit,
  type Prisma,
  type RaidModeIncident,
  type RaidModeLockdownState,
} from '@pavisie/database';
import { resolveTextChannel, type PluginContext, type PluginJob } from '../sdk';
import { incidentButtons, incidentEmbed, reminderText } from './alert';
import { applyLockdown, restoreChanges } from './lockdown';
import type { RaidModeConfig } from './manifest';
import { HIGH_RISK_SCORE, scoreJoin, type RiskReason } from './scoring';
import {
  STATE_TTL_SECONDS,
  claimIncident,
  commitDrain,
  drainIncident,
  inCooldown,
  recordJoin,
  releaseIncident,
  startCooldown,
  withGuildLease,
} from './state';

const HOUR = 3_600_000;
export const UPDATE_INTERVAL_MS = 5_000;
export const UPDATE_JOB_NAME = 'update';
export const LOCKDOWN_JOB_NAME = 'auto-lockdown';
export const UPDATE_JOB_ATTEMPTS = 5;
export const SCORE_RETENTION_DAYS = 30;

/** States in which some channels may still be locked by raid mode. */
const LOCKED_STATES: readonly RaidModeLockdownState[] = ['LOCKING', 'LOCKED', 'PARTIALLY_RESTORED'];

export interface UpdateJobData {
  guildId: string;
  incidentId: string;
  tick: number;
}

export interface LockdownJobData {
  guildId: string;
  incidentId: string;
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

async function fetchGuild(ctx: PluginContext, guildId: string): Promise<Guild | null> {
  return ctx.client.guilds.cache.get(guildId) ?? (await ctx.client.guilds.fetch(guildId).catch(() => null));
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
  const accountCreatedAt = member.user.createdAt;
  const risk = scoreJoin({
    accountCreatedAt,
    joinedAt: new Date(now),
    hasCustomAvatar: member.user.avatar !== null,
    username: member.user.username,
    flaggedSpammer: member.user.flags?.has('Spammer') ?? false,
  });
  const isNewAccount = now - accountCreatedAt.getTime() < config.newAccountMaxAgeHours * HOUR;
  const payload: QueuedScore | null =
    risk.level === 'low' ? null : { u: member.id, s: risk.score, r: risk.reasons, j: now };

  const record = await recordJoin(ctx, member.guild.id, {
    userId: member.id,
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
  // Right after a raid ended or was restored, a new one only alerts; an admin can still lock down by hand.
  const cooldown = !config.dryRun && (await inCooldown(ctx, guild.id));
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
          autoLockdownSuppressedByCooldown: cooldown,
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
      'raidmode: could not schedule incident updates; the hourly maintenance job will close it',
    ),
  );
  await postAlert(ctx, guild, config, incident);
  if (!config.dryRun && !cooldown) {
    // Queued, not inline: up to 100 channel edits must not run inside the guildMemberAdd handler, and a queued
    // job retries if the bot restarts part-way.
    await ctx
      .queue(LOCKDOWN_JOB_NAME)
      .add(
        LOCKDOWN_JOB_NAME,
        { guildId: guild.id, incidentId },
        {
          jobId: `raidmode-lockdown-${incidentId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      )
      .catch((err: unknown) =>
        ctx.logger.error(
          { guildId: guild.id, incidentId, err: err instanceof Error ? err.message : String(err) },
          'raidmode: could not queue the automatic lockdown; staff can still press "Lock down now"',
        ),
      );
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
 * Moves an incident's Redis counters and queued scores into the database and, once it has gone quiet (or
 * `forceEnd`), ends it. Redis is only trimmed after the database committed, so a failed transaction loses
 * nothing: the job's retry reads the same counters and scores again. Returns the updated row, or null when the
 * incident is already ended or gone.
 */
async function flushIncident(
  ctx: PluginContext,
  guildId: string,
  incidentId: string,
  quietMs: number,
  forceEnd = false,
): Promise<{ incident: RaidModeIncident; ending: boolean } | null> {
  const existing = await ctx.prisma.raidModeIncident.findUnique({ where: { id: incidentId } });
  if (!existing || existing.status === 'ENDED') return null;
  const now = Date.now();
  const drain = await drainIncident(ctx, guildId, incidentId, now, forceEnd ? 1 : quietMs);
  const ending = forceEnd || !drain.stillActive;
  const scores = parseQueuedScores(drain.scorePayloads);

  const incident = await ctx.prisma.$transaction(async (tx) => {
    const data: Prisma.RaidModeIncidentUpdateInput = {};
    if (drain.hasState) {
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
          ...(forceEnd ? { reason: 'stale' } : {}),
        },
        source: 'system',
      });
    }
    return updated;
  });
  await commitDrain(ctx, incidentId, scores.length, ending).catch(() => undefined);
  return { incident, ending };
}

/** Every few seconds while an incident is active. Re-queues itself until the incident ends. */
export const updateJob: PluginJob<UpdateJobData> = {
  name: UPDATE_JOB_NAME,
  concurrency: 5,
  async processor(ctx, job) {
    const { guildId, incidentId, tick } = job.data;
    const config = await ctx.getConfig<RaidModeConfig>(guildId);
    const result = await flushIncident(ctx, guildId, incidentId, config.quietMinutes * 60_000);
    if (!result) return;

    const guild = await fetchGuild(ctx, guildId);
    if (guild) {
      await refreshAlert(ctx, guild, result.incident);
      if (result.ending) await remindIfStillLocked(ctx, guild, config, result.incident);
    }
    if (result.ending) {
      await startCooldown(ctx, guildId, config.autoLockdownCooldownMinutes).catch(() => undefined);
    } else {
      await scheduleUpdate(ctx, { guildId, incidentId, tick: tick + 1 });
    }
  },
};

/** The automatic lockdown, queued by `startIncident`. Throws on "busy" so the queue retries it. */
export const lockdownJob: PluginJob<LockdownJobData> = {
  name: LOCKDOWN_JOB_NAME,
  concurrency: 2,
  async processor(ctx, job) {
    const { guildId, incidentId } = job.data;
    const guild = await fetchGuild(ctx, guildId);
    if (!guild) return;
    const outcome = await lockdownIncident(ctx, guild, incidentId, 'auto');
    if (outcome.status === 'busy') throw new Error('raidmode: lockdown or restore already running; retrying');
  },
};

/** Once the raid is over, tell staff (once) if the lockdown is still on. It is never lifted automatically. */
async function remindIfStillLocked(
  ctx: PluginContext,
  guild: Guild,
  config: RaidModeConfig,
  incident: RaidModeIncident,
): Promise<void> {
  if (!LOCKED_STATES.includes(incident.lockdownState) || incident.reminderSentAt) return;
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
  | {
      status: 'locked';
      incident: RaidModeIncident;
      channelsLocked: number;
      channelsNotCovered: number;
      failures: number;
    }
  | { status: 'already_locked' | 'nothing_to_lock' | 'busy' | 'not_found' };

/** A fenced final write found the incident in an unexpected state: another run got there first. */
class StateConflict extends Error {}

export async function lockdownIncident(
  ctx: PluginContext,
  guild: Guild,
  incidentId: string,
  actor: 'auto' | string,
): Promise<LockdownOutcome> {
  const outcome = await withGuildLease(ctx, guild.id, async (): Promise<LockdownOutcome> => {
    const incident = await ctx.prisma.raidModeIncident.findUnique({ where: { id: incidentId } });
    if (!incident || incident.guildId !== guild.id) return { status: 'not_found' };
    if (LOCKED_STATES.includes(incident.lockdownState)) return { status: 'already_locked' };
    const before = incident.lockdownState;

    // Marked LOCKING before the first Discord edit, so restore can find this lockdown even if the process stops
    // half-way. Conditional on the state just read: a concurrent run cannot also claim it.
    const claimed = await ctx.prisma.raidModeIncident.updateMany({
      where: { id: incidentId, lockdownState: before },
      data: { lockdownState: 'LOCKING', lockdownAppliedAt: new Date(), lockdownAppliedBy: actor },
    });
    if (claimed.count === 0) return { status: 'already_locked' };

    const config = await ctx.getConfig<RaidModeConfig>(guild.id);
    const reason = `Raid mode lockdown (${actor === 'auto' ? 'automatic' : `by ${actor}`})`;
    const result = await applyLockdown(ctx, guild, config, incidentId, reason);
    if (result.actions.length === 0) {
      await ctx.prisma.raidModeIncident.update({
        where: { id: incidentId },
        data: {
          lockdownState: before,
          lockdownAppliedAt: incident.lockdownAppliedAt,
          lockdownAppliedBy: incident.lockdownAppliedBy,
        },
      });
      return { status: 'nothing_to_lock' };
    }

    const updated = await ctx.prisma.$transaction(async (tx) => {
      const fenced = await tx.raidModeIncident.updateMany({
        where: { id: incidentId, lockdownState: 'LOCKING' },
        data: {
          lockdownState: 'LOCKED',
          lockdownActions: result.actions,
          lockdownRestoredAt: null,
          lockdownRestoredBy: null,
          reminderSentAt: null,
        },
      });
      if (fenced.count === 0) throw new StateConflict('raidmode: incident changed during lockdown');
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
          channelsNotCovered: result.channelsNotCovered,
          failures: result.failures,
        },
        source: actor === 'auto' ? 'system' : 'bot',
      });
      const row = await tx.raidModeIncident.findUnique({ where: { id: incidentId } });
      if (!row) throw new StateConflict('raidmode: incident disappeared during lockdown');
      return row;
    });
    await refreshAlert(ctx, guild, updated);
    return {
      status: 'locked',
      incident: updated,
      channelsLocked: result.channelsLocked,
      channelsNotCovered: result.channelsNotCovered,
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
  const outcome = await withGuildLease(ctx, guild.id, async (): Promise<RestoreOutcome> => {
    const incident = await ctx.prisma.raidModeIncident.findUnique({ where: { id: incidentId } });
    if (!incident || incident.guildId !== guild.id) return { status: 'not_found' };
    // Acts on what is actually outstanding, whatever the state says: a lockdown cut short by a restart is still
    // LOCKING (or even NONE, if it stopped before that write) but its change rows are here.
    const changes = await ctx.prisma.raidModeLockdownChange.findMany({
      where: { incidentId, restoreSkippedReason: null },
    });
    if (changes.length === 0 && !LOCKED_STATES.includes(incident.lockdownState))
      return { status: 'not_locked' };

    const result = await restoreChanges(ctx, guild, changes, `Raid mode restore by ${actorId}`);
    const state: RaidModeLockdownState = result.failedIds.length > 0 ? 'PARTIALLY_RESTORED' : 'RESTORED';
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
      const fenced = await tx.raidModeIncident.updateMany({
        where: { id: incidentId, lockdownState: incident.lockdownState },
        data: { lockdownState: state, lockdownRestoredAt: new Date(), lockdownRestoredBy: actorId },
      });
      if (fenced.count === 0) throw new StateConflict('raidmode: incident changed during restore');
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
      const row = await tx.raidModeIncident.findUnique({ where: { id: incidentId } });
      if (!row) throw new StateConflict('raidmode: incident disappeared during restore');
      return row;
    });
    if (state === 'RESTORED') {
      const config = await ctx.getConfig<RaidModeConfig>(guild.id);
      await startCooldown(ctx, guild.id, config.autoLockdownCooldownMinutes).catch(() => undefined);
    }
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
// Maintenance and retention
// ---------------------------------------------------------------------------------------------------------

/**
 * Hourly:
 * 1. Ends any incident still ACTIVE long after its last join (its update job was lost), so the overview never
 *    shows a raid in progress forever.
 * 2. Deletes risk scores 30 days after their incident ended.
 * 3. Deletes ended incidents older than the server's audit-log retention, once nothing is left locked.
 * Each purge writes one audit row of counts per server.
 */
export const maintenanceJob: PluginJob<Record<string, never>> = {
  name: 'maintenance',
  repeat: { pattern: '23 * * * *' },
  async processor(ctx) {
    const now = Date.now();

    const stale = await ctx.prisma.raidModeIncident.findMany({
      where: { status: 'ACTIVE', lastJoinAt: { lt: new Date(now - STATE_TTL_SECONDS * 1000) } },
      select: { id: true, guildId: true },
      take: 100,
    });
    for (const row of stale) {
      await flushIncident(ctx, row.guildId, row.id, 0, true).catch((err: unknown) =>
        ctx.logger.error(
          { guildId: row.guildId, incidentId: row.id, err: err instanceof Error ? err.message : String(err) },
          'raidmode: could not close a stale incident',
        ),
      );
    }

    const scoreCutoff = new Date(now - SCORE_RETENTION_DAYS * 24 * HOUR);
    const withOldScores = await ctx.prisma.raidModeIncident.findMany({
      where: { status: 'ENDED', endedAt: { lt: scoreCutoff }, scores: { some: {} } },
      select: { id: true, guildId: true },
      take: 500,
    });
    for (const [guildId, incidentIds] of groupByGuild(withOldScores)) {
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

    const ended = await ctx.prisma.raidModeIncident.findMany({
      where: { status: 'ENDED', lockdownState: { in: ['NONE', 'RESTORED'] }, changes: { none: {} } },
      select: { id: true, guildId: true, endedAt: true },
      orderBy: { endedAt: 'asc' },
      take: 500,
    });
    for (const [guildId, rows] of groupRowsByGuild(ended)) {
      const policy = await ctx.prisma.dataRetentionPolicy.findUnique({ where: { guildId } });
      const days = policy?.auditLogDays ?? 365;
      const cutoff = new Date(now - days * 24 * HOUR);
      const expired = rows.filter((r) => r.endedAt && r.endedAt < cutoff).map((r) => r.id);
      if (expired.length === 0) continue;
      await ctx.prisma.$transaction(async (tx) => {
        const deleted = await tx.raidModeIncident.deleteMany({ where: { id: { in: expired } } });
        await writeAudit(tx, {
          guildId,
          actorId: botId(ctx),
          actorType: 'system',
          action: AuditAction.RaidModeIncidentsPurge,
          targetType: 'raidmode_incident',
          after: { deleted: deleted.count, retentionDays: days },
          source: 'system',
        });
      });
    }
  },
};

function groupByGuild(rows: { id: string; guildId: string }[]): Map<string, string[]> {
  const byGuild = new Map<string, string[]>();
  for (const row of rows) byGuild.set(row.guildId, [...(byGuild.get(row.guildId) ?? []), row.id]);
  return byGuild;
}

function groupRowsByGuild<T extends { guildId: string }>(rows: T[]): Map<string, T[]> {
  const byGuild = new Map<string, T[]>();
  for (const row of rows) byGuild.set(row.guildId, [...(byGuild.get(row.guildId) ?? []), row]);
  return byGuild;
}

/** The guild's most recent incident, for `/raidmode status`. */
export function latestIncident(ctx: PluginContext, guildId: string): Promise<RaidModeIncident | null> {
  return ctx.prisma.raidModeIncident.findFirst({ where: { guildId }, orderBy: { startedAt: 'desc' } });
}

/** The newest incident with anything still locked, for `/raidmode restore` (not just the latest incident). */
export async function latestLockedIncident(
  ctx: PluginContext,
  guildId: string,
): Promise<RaidModeIncident | null> {
  const byState = await ctx.prisma.raidModeIncident.findFirst({
    where: { guildId, lockdownState: { in: [...LOCKED_STATES] } },
    orderBy: { startedAt: 'desc' },
  });
  if (byState) return byState;
  // A lockdown that stopped before even marking LOCKING still has change rows; find it through them.
  const change = await ctx.prisma.raidModeLockdownChange.findFirst({
    where: { guildId, restoreSkippedReason: null },
    orderBy: { createdAt: 'desc' },
  });
  return change ? ctx.prisma.raidModeIncident.findUnique({ where: { id: change.incidentId } }) : null;
}
