import type { Job } from 'bullmq';
import { ChannelType, GuildVerificationLevel, PermissionFlagsBits } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  crossesThreshold,
  handleJoin,
  latestLockedIncident,
  lockdownIncident,
  lockdownJob,
  maintenanceJob,
  restoreIncident,
  updateJob,
  type LockdownJobData,
  type UpdateJobData,
} from '../incident';
import { configSchema } from '../manifest';
import { scoreJoin } from '../scoring';
import { ADMIN_ID, FakeChannel, harness } from './harness';

// ioredis-mock shares one dataset across instances, so every test uses its own guild id.

const SEND = PermissionFlagsBits.SendMessages;
type H = ReturnType<typeof harness>;

const runUpdate = (h: H) =>
  updateJob.processor(h.ctx, { data: h.queued[h.queued.length - 1] } as Job<UpdateJobData>);
/** Runs the queued automatic lockdown, the way the worker would. */
const runAutoLockdown = (h: H) => {
  const job = [...h.jobs].reverse().find((j) => j.name === 'auto-lockdown');
  if (!job) throw new Error('no automatic lockdown queued');
  return lockdownJob.processor(h.ctx, { data: job.data } as Job<LockdownJobData>);
};
const joinBurst = async (h: H, n = 5) => {
  for (let i = 0; i < n; i += 1) await handleJoin(h.ctx, h.member());
};
const isLocked = (channel: FakeChannel, everyoneId: string) =>
  ((channel.overwrites.get(everyoneId)?.deny ?? 0n) & SEND) === SEND;
const incidentId = (h: H, i = 0) => h.db.incidents[i]!.id as string;

afterEach(() => {
  vi.useRealTimers();
});

describe('scoring', () => {
  const base = {
    accountCreatedAt: new Date('2020-01-01'),
    joinedAt: new Date('2026-11-14'),
    hasCustomAvatar: true,
    username: 'playerone',
    flaggedSpammer: false,
  };

  it('scores an established account low, with no reasons', () => {
    expect(scoreJoin(base)).toEqual({ score: 0, level: 'low', reasons: [] });
  });

  it('scores a minutes-old, default-avatar, numbered account high', () => {
    const risk = scoreJoin({
      ...base,
      accountCreatedAt: new Date(base.joinedAt.getTime() - 10 * 60_000),
      hasCustomAvatar: false,
      username: 'raider48213',
    });
    expect(risk.level).toBe('high');
    expect(risk.reasons).toEqual(['account_age_lt_1h', 'default_avatar', 'numbered_username']);
  });

  it("treats Discord's spammer flag as high risk on its own", () => {
    expect(scoreJoin({ ...base, flaggedSpammer: true }).level).toBe('high');
  });
});

describe('config', () => {
  it('needs both the join count and the new-account share', () => {
    const config = configSchema.parse({ joinThreshold: 10, newAccountSharePct: 50 });
    expect(crossesThreshold(config, 9, 9)).toBe(false);
    expect(crossesThreshold(config, 10, 4)).toBe(false);
    expect(crossesThreshold(config, 10, 5)).toBe(true);
  });

  it('refuses thresholds that ordinary traffic could trip once automatic lockdown is on', () => {
    expect(() => configSchema.parse({ dryRun: false, joinThreshold: 3 })).toThrow(/at least 5/);
    expect(() => configSchema.parse({ dryRun: false, newAccountSharePct: 0 })).toThrow(/at least 20%/);
    // Dry run only alerts, so the low floors stay allowed there.
    expect(configSchema.parse({ dryRun: true, joinThreshold: 3, newAccountSharePct: 0 }).joinThreshold).toBe(
      3,
    );
  });

  it('only accepts Discord ids for channels', () => {
    expect(() => configSchema.parse({ alertChannelId: 'general' })).toThrow();
    expect(() => configSchema.parse({ lockdownChannelIds: ['123'] })).toThrow();
    expect(configSchema.parse({ alertChannelId: '123456789012345678' }).alertChannelId).toBe(
      '123456789012345678',
    );
  });
});

describe('detection', () => {
  it('starts one incident when joins cross the threshold, with an audit row in the same transaction', async () => {
    const h = harness('rm-start');
    await joinBurst(h, 4);
    expect(h.db.incidents).toHaveLength(0);

    await handleJoin(h.ctx, h.member());

    expect(h.db.incidents).toHaveLength(1);
    expect(h.db.incidents[0]).toMatchObject({
      status: 'ACTIVE',
      dryRun: true,
      joinsTotal: 5,
      joinsFlagged: 5,
    });
    expect(h.db.audits.map((a) => a.action)).toEqual(['raidmode.incident.start']);
    expect(h.alert.sent).toHaveLength(1);
    expect(h.queued).toHaveLength(1);
  });

  it('starts a single incident when the threshold is crossed by many joins at once', async () => {
    const h = harness('rm-concurrent');
    await Promise.all(Array.from({ length: 40 }, () => handleJoin(h.ctx, h.member())));
    expect(h.db.incidents).toHaveLength(1);
    expect(h.alert.sent).toHaveLength(1);
  });

  it('counts members, not join events: 3 accounts rejoining 10 times each start nothing', async () => {
    const h = harness('rm-rejoin-loop', { config: { dryRun: false, joinThreshold: 5 } });
    const loopers = [h.member(), h.member(), h.member()];
    for (let round = 0; round < 10; round += 1) {
      for (const member of loopers) await handleJoin(h.ctx, member);
    }
    expect(h.db.incidents).toHaveLength(0);
  });

  it('ignores a burst of established accounts', async () => {
    const h = harness('rm-old-accounts');
    for (let i = 0; i < 20; i += 1) await handleJoin(h.ctx, h.member({ ageHours: 24 * 400, avatar: true }));
    expect(h.db.incidents).toHaveLength(0);
  });

  it('ignores bots', async () => {
    const h = harness('rm-bots');
    for (let i = 0; i < 20; i += 1) await handleJoin(h.ctx, h.member({ bot: true }));
    expect(h.db.incidents).toHaveLength(0);
  });

  it('does not keep the slot when the incident cannot be saved, so the next join can try again', async () => {
    const h = harness('rm-start-fails');
    h.db.failAudit = true;
    await joinBurst(h, 4);
    await expect(handleJoin(h.ctx, h.member())).rejects.toThrow('audit insert failed');
    expect(h.db.incidents).toHaveLength(0);

    h.db.failAudit = false;
    await handleJoin(h.ctx, h.member());
    expect(h.db.incidents).toHaveLength(1);
  });
});

describe('scores, counts and the end of an incident', () => {
  it('stores only medium and high scores, with member id, score and reason codes', async () => {
    const h = harness('rm-scores');
    await joinBurst(h);
    await handleJoin(h.ctx, h.member({ ageHours: 0.1, username: 'raider12345' })); // high
    await handleJoin(h.ctx, h.member({ ageHours: 24 * 400, avatar: true })); // low: not stored

    await runUpdate(h);

    expect(h.db.scores).toHaveLength(1);
    expect(Object.keys(h.db.scores[0]!).sort()).toEqual(
      ['guildId', 'id', 'incidentId', 'joinedAt', 'reasons', 'score', 'userId'].sort(),
    );
    expect(h.db.incidents[0]).toMatchObject({ joinsTotal: 7, riskHigh: 1, riskLow: 1 });
    const batch = h.db.audits.find((a) => a.action === 'raidmode.scores.record');
    // The audit row has counts only, never the scored members.
    expect(batch?.after).toEqual({ recorded: 1, high: 1, medium: 0 });
    expect(JSON.stringify(batch)).not.toContain(h.db.scores[0]!.userId as string);
  });

  it('keeps queued scores when the database write fails, and writes them on the retry', async () => {
    const h = harness('rm-drain-retry');
    await joinBurst(h);
    await handleJoin(h.ctx, h.member({ ageHours: 0.1, username: 'raider12345' }));

    h.db.failAudit = true;
    await expect(runUpdate(h)).rejects.toThrow('audit insert failed');
    expect(h.db.scores).toHaveLength(0);

    h.db.failAudit = false;
    await runUpdate(h);
    expect(h.db.scores).toHaveLength(1);
  });

  it('ends the incident after the quiet period and audits the end', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('rm-end', { config: { quietMinutes: 1 } });
    await joinBurst(h);
    await runUpdate(h);
    expect(h.db.incidents[0]?.status).toBe('ACTIVE');

    vi.advanceTimersByTime(61_000);
    await runUpdate(h);

    expect(h.db.incidents[0]).toMatchObject({ status: 'ENDED' });
    expect(h.db.audits.map((a) => a.action)).toContain('raidmode.incident.end');
    expect(h.alert.sent).toHaveLength(1); // dry run: nothing locked, no reminder
  });

  it('a lost update job does not leave the incident active forever', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('rm-stale');
    await joinBurst(h);
    // The update chain is lost. Hours later, the hourly maintenance job runs.
    vi.advanceTimersByTime(7 * 3_600_000);

    await maintenanceJob.processor(h.ctx, {} as Job<Record<string, never>>);

    expect(h.db.incidents[0]).toMatchObject({ status: 'ENDED' });
    expect(h.db.audits.find((a) => a.action === 'raidmode.incident.end')?.after).toMatchObject({
      reason: 'stale',
    });
  });
});

describe('lockdown and exact restore', () => {
  it('a dry-run raid is not locked down automatically', async () => {
    const h = harness('rm-dry');
    await joinBurst(h);
    expect(h.jobs.some((j) => j.name === 'auto-lockdown')).toBe(false);
    expect(h.channels.every((c) => c.overwrites.size === 0)).toBe(true);
  });

  it('queues the automatic lockdown instead of running it in the join handler', async () => {
    const h = harness('rm-auto', { config: { dryRun: false } });
    await joinBurst(h);
    expect(h.channels.every((c) => c.overwrites.size === 0)).toBe(true);

    await runAutoLockdown(h);

    expect(h.db.incidents[0]).toMatchObject({
      lockdownState: 'LOCKED',
      lockdownAppliedBy: 'auto',
      lockdownActions: ['channel-send-deny'],
    });
    expect(h.channels.every((c) => isLocked(c, 'rm-auto'))).toBe(true);
    expect(h.alert.overwrites.size).toBe(0); // the alert channel is never locked
    expect(h.db.audits.filter((a) => a.action === 'raidmode.lockdown.apply')).toHaveLength(1);
  });

  it('restore puts back exactly the previous state of each channel', async () => {
    const h = harness('rm-restore', { config: { dryRun: false }, channels: 3 });
    const [noOverwrite, allowed, otherFlags] = h.channels;
    // c1: @everyone explicitly allowed to send. c2: an unrelated flag already denied, which must survive.
    allowed!.overwrites.set('rm-restore', { allow: SEND, deny: 0n });
    otherFlags!.overwrites.set('rm-restore', { allow: 0n, deny: PermissionFlagsBits.AttachFiles });
    await joinBurst(h);
    await runAutoLockdown(h);

    const outcome = await restoreIncident(h.ctx, h.guild, incidentId(h), ADMIN_ID);

    expect(outcome.status).toBe('restored');
    expect(noOverwrite!.overwrites.has('rm-restore')).toBe(false);
    expect(allowed!.overwrites.get('rm-restore')).toEqual({ allow: SEND, deny: 0n });
    expect(otherFlags!.overwrites.get('rm-restore')).toEqual({
      allow: 0n,
      deny: PermissionFlagsBits.AttachFiles,
    });
    expect(h.db.changes).toHaveLength(0);
    expect(h.db.incidents[0]).toMatchObject({ lockdownState: 'RESTORED', lockdownRestoredBy: ADMIN_ID });
    expect(h.db.audits.find((a) => a.action === 'raidmode.lockdown.restore')).toMatchObject({
      actorId: ADMIN_ID,
      after: { restored: 3, skipped: [], failed: 0 },
    });
  });

  it('restore still works when the final lockdown write fails part-way (blocker 1)', async () => {
    const h = harness('rm-crash-final', { config: { dryRun: false }, channels: 3 });
    await joinBurst(h);
    h.db.failAudit = true;
    await expect(runAutoLockdown(h)).rejects.toThrow('audit insert failed');
    // Channels are locked, the final transaction never committed: the incident says LOCKING, not LOCKED.
    expect(h.channels.every((c) => isLocked(c, 'rm-crash-final'))).toBe(true);
    expect(h.db.incidents[0]?.lockdownState).toBe('LOCKING');

    h.db.failAudit = false;
    const outcome = await restoreIncident(h.ctx, h.guild, incidentId(h), ADMIN_ID);

    expect(outcome.status).toBe('restored');
    expect(h.channels.every((c) => c.overwrites.size === 0)).toBe(true);
  });

  it('restore still works when the process stops in the middle of locking (blocker 1)', async () => {
    const h = harness('rm-crash-mid', { config: { dryRun: false }, channels: 3 });
    await joinBurst(h);
    h.db.failChangeCreateAfter = 2; // two channels done, the third never starts
    await expect(runAutoLockdown(h)).rejects.toThrow('process stopped');
    expect(h.channels.filter((c) => isLocked(c, 'rm-crash-mid'))).toHaveLength(2);

    h.db.failChangeCreateAfter = null;
    expect((await latestLockedIncident(h.ctx, 'rm-crash-mid'))?.id).toBe(incidentId(h));
    const outcome = await restoreIncident(h.ctx, h.guild, incidentId(h), ADMIN_ID);

    expect(outcome).toMatchObject({ status: 'restored', restored: 2 });
    expect(h.channels.every((c) => c.overwrites.size === 0)).toBe(true);
  });

  it('reports a change whose edit never landed as not applied, not as changed by an admin', async () => {
    const h = harness('rm-not-applied', { config: { dryRun: false }, channels: 1 });
    await joinBurst(h);
    h.channels[0]!.failEdits = true;
    await runAutoLockdown(h);
    // The refused edit's row was cleaned up; simulate the crash case where it was left behind.
    h.db.changes.push({
      id: 'stray',
      incidentId: incidentId(h),
      guildId: 'rm-not-applied',
      kind: 'CHANNEL_OVERWRITE',
      channelId: h.channels[0]!.id,
      targetId: 'rm-not-applied',
      previousFlags: {},
      previousOverwriteExisted: false,
      restoreSkippedReason: null,
    });
    h.channels[0]!.failEdits = false;

    const outcome = await restoreIncident(h.ctx, h.guild, incidentId(h), ADMIN_ID);

    expect(outcome).toMatchObject({ skipped: [{ channelId: h.channels[0]!.id, reason: 'not_applied' }] });
  });

  it('restore leaves a channel an admin changed during the raid, and says so', async () => {
    const h = harness('rm-admin-edit', { config: { dryRun: false }, channels: 2 });
    await joinBurst(h);
    await runAutoLockdown(h);
    const reopened = h.channels[0]!;
    reopened.overwrites.set('rm-admin-edit', { allow: SEND, deny: 0n });

    const outcome = await restoreIncident(h.ctx, h.guild, incidentId(h), ADMIN_ID);

    expect(outcome).toMatchObject({
      status: 'restored',
      restored: 1,
      skipped: [{ channelId: reopened.id, reason: 'changed_by_admin' }],
    });
    expect(reopened.overwrites.get('rm-admin-edit')).toEqual({ allow: SEND, deny: 0n });
  });

  it('a restore Discord refuses can be retried', async () => {
    const h = harness('rm-retry', { config: { dryRun: false }, channels: 1 });
    await joinBurst(h);
    await runAutoLockdown(h);
    h.channels[0]!.failEdits = true;

    expect((await restoreIncident(h.ctx, h.guild, incidentId(h), ADMIN_ID)).status).toBe(
      'partially_restored',
    );
    expect(h.db.changes).toHaveLength(1);

    h.channels[0]!.failEdits = false;
    expect((await restoreIncident(h.ctx, h.guild, incidentId(h), ADMIN_ID)).status).toBe('restored');
    expect(h.channels[0]!.overwrites.has('rm-retry')).toBe(false);
  });

  it('lockdown and restore never run at once for one server, even across incidents', async () => {
    const h = harness('rm-guild-lease', { config: { dryRun: false } });
    await joinBurst(h);
    await runAutoLockdown(h);
    h.db.incidents.push({ ...h.db.incidents[0]!, id: 'second', lockdownState: 'NONE' });

    const outcomes = await Promise.all([
      restoreIncident(h.ctx, h.guild, incidentId(h), ADMIN_ID),
      lockdownIncident(h.ctx, h.guild, 'second', ADMIN_ID),
    ]);

    expect(outcomes.map((o) => o.status)).toContain('busy');
  });

  it('covers forum, voice and stage channels, skips channels @everyone cannot see, and goes in sidebar order', async () => {
    const h = harness('rm-coverage', { config: { dryRun: false }, channels: 4 });
    const [forum, voice, hidden, text] = h.channels;
    forum!.type = ChannelType.GuildForum;
    voice!.type = ChannelType.GuildVoice;
    hidden!.everyoneCanView = false;
    text!.rawPosition = -1; // first in the sidebar
    await joinBurst(h);
    await runAutoLockdown(h);

    expect(isLocked(forum!, 'rm-coverage')).toBe(true);
    expect(isLocked(voice!, 'rm-coverage')).toBe(true);
    expect(hidden!.overwrites.size).toBe(0);
    expect(h.db.changes.map((c) => c.channelId)).toEqual([text!.id, forum!.id, voice!.id]);
  });

  it('reports channels left open by the 100-channel cap instead of dropping them silently', async () => {
    const h = harness('rm-cap', { config: { dryRun: false }, channels: 103 });
    await joinBurst(h);
    await runAutoLockdown(h);

    expect(h.db.changes).toHaveLength(100);
    expect(h.db.audits.find((a) => a.action === 'raidmode.lockdown.apply')?.after).toMatchObject({
      channelsLocked: 100,
      channelsNotCovered: 3,
    });
  });

  it('raises verification and pauses invites only when asked, and restores both', async () => {
    const h = harness('rm-guild-level', {
      config: { dryRun: false, raiseVerification: true, pauseInvites: true },
      verificationLevel: GuildVerificationLevel.Low,
    });
    await joinBurst(h);
    await runAutoLockdown(h);
    expect(h.rawGuild.verificationLevel).toBe(GuildVerificationLevel.High);
    expect(h.rawGuild.features).toContain('INVITES_DISABLED');

    await restoreIncident(h.ctx, h.guild, incidentId(h), ADMIN_ID);

    expect(h.rawGuild.verificationLevel).toBe(GuildVerificationLevel.Low);
    expect(h.rawGuild.features).not.toContain('INVITES_DISABLED');
  });

  it('a manual "Lock down now" on a dry-run incident is recorded as the admin', async () => {
    const h = harness('rm-manual');
    await joinBurst(h);

    const outcome = await lockdownIncident(h.ctx, h.guild, incidentId(h), ADMIN_ID);

    expect(outcome.status).toBe('locked');
    expect(h.db.audits.find((a) => a.action === 'raidmode.lockdown.apply')).toMatchObject({
      actorId: ADMIN_ID,
      actorType: 'USER',
    });
  });

  it('never lifts a lockdown on its own: after the quiet period it reminds staff once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('rm-remind', { config: { dryRun: false, quietMinutes: 1 } });
    await joinBurst(h);
    await runAutoLockdown(h);

    vi.advanceTimersByTime(61_000);
    await runUpdate(h);

    expect(h.db.incidents[0]).toMatchObject({ status: 'ENDED', lockdownState: 'LOCKED' });
    expect(h.channels.every((c) => isLocked(c, 'rm-remind'))).toBe(true);
    expect(h.alert.sent).toHaveLength(2);
    expect(JSON.stringify(h.alert.sent[1])).toContain('still on');
    expect(h.db.incidents[0]?.reminderSentAt).toBeInstanceOf(Date);
  });

  it('after a restore, a new raid only alerts: no automatic lockdown during the cooldown (blocker 2)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('rm-cooldown', {
      config: { dryRun: false, quietMinutes: 1, autoLockdownCooldownMinutes: 30 },
    });
    await joinBurst(h);
    await runAutoLockdown(h);
    await restoreIncident(h.ctx, h.guild, incidentId(h), ADMIN_ID);
    vi.advanceTimersByTime(61_000);
    await runUpdate(h); // the first incident ends

    vi.advanceTimersByTime(60_000);
    const lockdownsBefore = h.jobs.filter((j) => j.name === 'auto-lockdown').length;
    await joinBurst(h);

    expect(h.db.incidents).toHaveLength(2);
    expect(h.jobs.filter((j) => j.name === 'auto-lockdown')).toHaveLength(lockdownsBefore);
    expect(h.db.audits.filter((a) => a.action === 'raidmode.incident.start')[1]?.after).toMatchObject({
      autoLockdownSuppressedByCooldown: true,
    });
  });
});

describe('retention', () => {
  it('purges scores 30 days after an incident ends, with one audit row of counts', async () => {
    const h = harness('rm-purge');
    const old = new Date(Date.now() - 31 * 24 * 3_600_000);
    h.db.incidents.push({
      id: 'old',
      guildId: 'rm-purge',
      status: 'ENDED',
      endedAt: old,
      lockdownState: 'NONE',
    });
    h.db.incidents.push({
      id: 'recent',
      guildId: 'rm-purge',
      status: 'ENDED',
      endedAt: new Date(),
      lockdownState: 'NONE',
    });
    h.db.scores.push(
      { id: 's1', incidentId: 'old', userId: 'a' },
      { id: 's2', incidentId: 'recent', userId: 'b' },
    );

    await maintenanceJob.processor(h.ctx, {} as Job<Record<string, never>>);

    expect(h.db.scores.map((s) => s.id)).toEqual(['s2']);
    expect(h.db.audits.find((a) => a.action === 'raidmode.scores.purge')?.after).toEqual({
      deleted: 1,
      incidents: 1,
      retentionDays: 30,
    });
  });

  it("deletes ended incidents after the server's audit-log retention, never one still locked", async () => {
    const h = harness('rm-incident-purge');
    h.db.retention = { auditLogDays: 90 };
    const old = new Date(Date.now() - 91 * 24 * 3_600_000);
    h.db.incidents.push(
      {
        id: 'expired',
        guildId: 'rm-incident-purge',
        status: 'ENDED',
        endedAt: old,
        lockdownState: 'RESTORED',
      },
      {
        id: 'still-locked',
        guildId: 'rm-incident-purge',
        status: 'ENDED',
        endedAt: old,
        lockdownState: 'LOCKED',
      },
      {
        id: 'young',
        guildId: 'rm-incident-purge',
        status: 'ENDED',
        endedAt: new Date(),
        lockdownState: 'NONE',
      },
    );

    await maintenanceJob.processor(h.ctx, {} as Job<Record<string, never>>);

    expect(h.db.incidents.map((i) => i.id).sort()).toEqual(['still-locked', 'young']);
    expect(h.db.audits.find((a) => a.action === 'raidmode.incidents.purge')?.after).toEqual({
      deleted: 1,
      retentionDays: 90,
    });
  });
});
