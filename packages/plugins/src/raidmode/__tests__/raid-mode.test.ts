import type { Job } from 'bullmq';
import { GuildVerificationLevel, PermissionFlagsBits } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  crossesThreshold,
  handleJoin,
  lockdownIncident,
  purgeJob,
  restoreIncident,
  updateJob,
  type UpdateJobData,
} from '../incident';
import { configSchema } from '../manifest';
import { scoreJoin } from '../scoring';
import { ADMIN_ID, harness } from './harness';

// ioredis-mock shares one dataset across instances, so every test uses its own guild id.

const SEND = PermissionFlagsBits.SendMessages;
const runUpdate = (h: ReturnType<typeof harness>) =>
  updateJob.processor(h.ctx, { data: h.queued[h.queued.length - 1] } as Job<UpdateJobData>);

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

describe('detection', () => {
  it('needs both the join count and the new-account share', () => {
    const config = configSchema.parse({ joinThreshold: 10, newAccountSharePct: 50 });
    expect(crossesThreshold(config, 9, 9)).toBe(false);
    expect(crossesThreshold(config, 10, 4)).toBe(false);
    expect(crossesThreshold(config, 10, 5)).toBe(true);
  });

  it('starts one incident when joins cross the threshold, with an audit row in the same transaction', async () => {
    const h = harness('rm-start');
    for (let i = 0; i < 4; i += 1) await handleJoin(h.ctx, h.member());
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
    for (let i = 0; i < 4; i += 1) await handleJoin(h.ctx, h.member());
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
    for (let i = 0; i < 5; i += 1) await handleJoin(h.ctx, h.member());
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

  it('ends the incident after the quiet period and audits the end', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('rm-end', { config: { quietMinutes: 1 } });
    for (let i = 0; i < 5; i += 1) await handleJoin(h.ctx, h.member());
    await runUpdate(h);
    expect(h.db.incidents[0]?.status).toBe('ACTIVE');

    vi.advanceTimersByTime(61_000);
    await runUpdate(h);

    expect(h.db.incidents[0]).toMatchObject({ status: 'ENDED' });
    expect(h.db.audits.map((a) => a.action)).toContain('raidmode.incident.end');
    // Dry run: nothing was locked, so no reminder.
    expect(h.alert.sent).toHaveLength(1);
  });
});

describe('lockdown and exact restore', () => {
  it('a dry-run raid is not locked down automatically', async () => {
    const h = harness('rm-dry');
    for (let i = 0; i < 5; i += 1) await handleJoin(h.ctx, h.member());
    expect(h.db.incidents[0]?.lockdownState).toBe('NONE');
    expect(h.channels.every((c) => c.overwrites.size === 0)).toBe(true);
  });

  it('locks down automatically when not in dry run, and audits it in the same transaction', async () => {
    const h = harness('rm-auto', { config: { dryRun: false } });
    for (let i = 0; i < 5; i += 1) await handleJoin(h.ctx, h.member());

    expect(h.db.incidents[0]).toMatchObject({
      lockdownState: 'LOCKED',
      lockdownAppliedBy: 'auto',
      lockdownActions: ['channel-send-deny'],
    });
    expect(h.channels.every((c) => (c.overwrites.get('rm-auto')!.deny & SEND) === SEND)).toBe(true);
    // The alert channel is never locked.
    expect(h.alert.overwrites.size).toBe(0);
    expect(h.db.audits.filter((a) => a.action === 'raidmode.lockdown.apply')).toHaveLength(1);
  });

  it('restore puts back exactly the previous state of each channel', async () => {
    const h = harness('rm-restore', { config: { dryRun: false }, channels: 3 });
    const [noOverwrite, allowed, otherFlags] = h.channels;
    // c1: @everyone explicitly allowed to send. c2: an unrelated flag already denied, which must survive.
    allowed!.overwrites.set('rm-restore', { allow: SEND, deny: 0n });
    otherFlags!.overwrites.set('rm-restore', { allow: 0n, deny: PermissionFlagsBits.AttachFiles });
    for (let i = 0; i < 5; i += 1) await handleJoin(h.ctx, h.member());
    const incidentId = h.db.incidents[0]!.id as string;

    const outcome = await restoreIncident(h.ctx, h.guild, incidentId, ADMIN_ID);

    expect(outcome.status).toBe('restored');
    expect(noOverwrite!.overwrites.has('rm-restore')).toBe(false);
    expect(allowed!.overwrites.get('rm-restore')).toEqual({ allow: SEND, deny: 0n });
    expect(otherFlags!.overwrites.get('rm-restore')).toEqual({
      allow: 0n,
      deny: PermissionFlagsBits.AttachFiles,
    });
    expect(h.db.changes).toHaveLength(0);
    expect(h.db.incidents[0]).toMatchObject({ lockdownState: 'RESTORED', lockdownRestoredBy: ADMIN_ID });
    const audit = h.db.audits.find((a) => a.action === 'raidmode.lockdown.restore');
    expect(audit).toMatchObject({ actorId: ADMIN_ID, after: { restored: 3, skipped: [], failed: 0 } });
  });

  it('restore leaves a channel an admin changed during the raid, and says so', async () => {
    const h = harness('rm-admin-edit', { config: { dryRun: false }, channels: 2 });
    for (let i = 0; i < 5; i += 1) await handleJoin(h.ctx, h.member());
    // An admin reopens one channel by hand mid-raid.
    const reopened = h.channels[0]!;
    reopened.overwrites.set('rm-admin-edit', { allow: SEND, deny: 0n });

    const outcome = await restoreIncident(h.ctx, h.guild, h.db.incidents[0]!.id as string, ADMIN_ID);

    expect(outcome).toMatchObject({
      status: 'restored',
      restored: 1,
      skipped: [{ channelId: reopened.id, reason: 'changed_by_admin' }],
    });
    expect(reopened.overwrites.get('rm-admin-edit')).toEqual({ allow: SEND, deny: 0n });
  });

  it('a restore Discord refuses can be retried', async () => {
    const h = harness('rm-retry', { config: { dryRun: false }, channels: 1 });
    for (let i = 0; i < 5; i += 1) await handleJoin(h.ctx, h.member());
    const incidentId = h.db.incidents[0]!.id as string;
    h.channels[0]!.failEdits = true;

    expect((await restoreIncident(h.ctx, h.guild, incidentId, ADMIN_ID)).status).toBe('partially_restored');
    expect(h.db.changes).toHaveLength(1);

    h.channels[0]!.failEdits = false;
    expect((await restoreIncident(h.ctx, h.guild, incidentId, ADMIN_ID)).status).toBe('restored');
    expect(h.channels[0]!.overwrites.has('rm-retry')).toBe(false);
  });

  it('two clicks on Restore at once restore once', async () => {
    const h = harness('rm-double', { config: { dryRun: false } });
    for (let i = 0; i < 5; i += 1) await handleJoin(h.ctx, h.member());
    const incidentId = h.db.incidents[0]!.id as string;

    const outcomes = await Promise.all([
      restoreIncident(h.ctx, h.guild, incidentId, ADMIN_ID),
      restoreIncident(h.ctx, h.guild, incidentId, ADMIN_ID),
    ]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(['busy', 'restored']);
    expect(h.db.audits.filter((a) => a.action === 'raidmode.lockdown.restore')).toHaveLength(1);
  });

  it('raises verification and pauses invites only when asked, and restores both', async () => {
    const h = harness('rm-guild-level', {
      config: { dryRun: false, raiseVerification: true, pauseInvites: true },
      verificationLevel: GuildVerificationLevel.Low,
    });
    for (let i = 0; i < 5; i += 1) await handleJoin(h.ctx, h.member());
    expect(h.rawGuild.verificationLevel).toBe(GuildVerificationLevel.High);
    expect(h.rawGuild.features).toContain('INVITES_DISABLED');

    await restoreIncident(h.ctx, h.guild, h.db.incidents[0]!.id as string, ADMIN_ID);

    expect(h.rawGuild.verificationLevel).toBe(GuildVerificationLevel.Low);
    expect(h.rawGuild.features).not.toContain('INVITES_DISABLED');
  });

  it('a manual "Lock down now" on a dry-run incident is recorded as the admin', async () => {
    const h = harness('rm-manual');
    for (let i = 0; i < 5; i += 1) await handleJoin(h.ctx, h.member());

    const outcome = await lockdownIncident(h.ctx, h.guild, h.db.incidents[0]!.id as string, ADMIN_ID);

    expect(outcome.status).toBe('locked');
    expect(h.db.audits.find((a) => a.action === 'raidmode.lockdown.apply')).toMatchObject({
      actorId: ADMIN_ID,
      actorType: 'USER',
    });
  });

  it('never lifts a lockdown on its own: after the quiet period it reminds staff once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('rm-remind', { config: { dryRun: false, quietMinutes: 1 } });
    for (let i = 0; i < 5; i += 1) await handleJoin(h.ctx, h.member());

    vi.advanceTimersByTime(61_000);
    await runUpdate(h);

    expect(h.db.incidents[0]).toMatchObject({ status: 'ENDED', lockdownState: 'LOCKED' });
    expect(h.channels.every((c) => (c.overwrites.get('rm-remind')!.deny & SEND) === SEND)).toBe(true);
    expect(h.alert.sent).toHaveLength(2);
    expect(JSON.stringify(h.alert.sent[1])).toContain('still on');
    expect(h.db.incidents[0]?.reminderSentAt).toBeInstanceOf(Date);
  });
});

describe('retention', () => {
  it('purges scores 30 days after an incident ends, with one audit row of counts', async () => {
    const h = harness('rm-purge');
    const old = new Date(Date.now() - 31 * 24 * 3_600_000);
    h.db.incidents.push({ id: 'old', guildId: 'rm-purge', status: 'ENDED', endedAt: old });
    h.db.incidents.push({ id: 'recent', guildId: 'rm-purge', status: 'ENDED', endedAt: new Date() });
    h.db.scores.push(
      { id: 's1', incidentId: 'old', userId: 'a' },
      { id: 's2', incidentId: 'recent', userId: 'b' },
    );

    await purgeJob.processor(h.ctx, {} as Job<Record<string, never>>);

    expect(h.db.scores.map((s) => s.id)).toEqual(['s2']);
    expect(h.db.audits).toEqual([
      expect.objectContaining({
        action: 'raidmode.scores.purge',
        after: { deleted: 1, incidents: 1, retentionDays: 30 },
      }),
    ]);
  });
});
