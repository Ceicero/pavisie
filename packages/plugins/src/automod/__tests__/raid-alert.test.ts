import type { Job } from 'bullmq';
import type { Guild, GuildMember } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomodRule } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import type { AutomodConfig } from '../manifest';
import {
  RAID_ALERT_QUIET_MS,
  RAID_ALERT_UPDATE_INTERVAL_MS,
  raidAlertJob,
  recordRaidAlertJoin,
  type RaidAlertJobData,
} from '../raid-alert';
import { handleMemberJoin } from '../service';

// A raid posts ONE staff alert and edits it, instead of one alert per joining account. These tests pin the three
// promises that makes: one message per raid, at most one edit per update interval, and a final "raid ended" edit.
//
// ioredis-mock shares one dataset across instances, so every test uses its own guild id.

interface Embedded {
  embeds: { toJSON(): { title?: string; fields?: { name: string; value: string }[] } }[];
}

function harness(guildId: string, options: { alertChannelId?: string | null; failEdits?: boolean } = {}) {
  const sent: Embedded[] = [];
  const edits: { messageId: string; payload: Embedded }[] = [];
  const queued: { data: RaidAlertJobData; jobId: string; delay: number }[] = [];
  const warnings: string[] = [];

  const channel = {
    id: 'alerts',
    type: 0,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload: Embedded) => {
      sent.push(payload);
      return { id: `alert-${sent.length}` };
    },
    messages: {
      edit: async (messageId: string, payload: Embedded) => {
        if (options.failEdits) throw new Error('Unknown Message');
        edits.push({ messageId, payload });
      },
    },
  };
  const guild = {
    id: guildId,
    ownerId: 'owner',
    members: { me: { id: 'bot' }, cache: new Map() },
    channels: { fetch: async () => channel },
  } as unknown as Guild;

  const { ctx, redis } = createTestContext({
    overrides: {
      client: { guilds: { cache: new Map([[guildId, guild]]) }, user: { id: 'bot' } } as never,
      queue: () =>
        ({
          add: async (_name: string, data: RaidAlertJobData, opts: { jobId: string; delay: number }) => {
            queued.push({ data, jobId: opts.jobId, delay: opts.delay });
          },
        }) as never,
      logger: {
        warn: (_obj: unknown, msg: string) => warnings.push(msg),
        error: (_obj: unknown, msg: string) => warnings.push(msg),
        info: () => undefined,
        debug: () => undefined,
      } as never,
    },
  });

  const join = () =>
    recordRaidAlertJoin(ctx, guild, {
      ruleId: 'raid-rule',
      ruleName: 'Join burst',
      alertChannelId: options.alertChannelId === undefined ? 'alerts' : options.alertChannelId,
      reason: '10 members joined within 30s (flags at 10 or more).',
      actionsText: '✅ alert_staff',
      dryRun: false,
    });
  /** Runs the most recently queued update job, the way the worker would once its delay has passed. */
  const runUpdate = async () => {
    const next = queued[queued.length - 1];
    if (!next) throw new Error('no update job queued');
    await raidAlertJob.processor(ctx, { data: next.data } as Job<RaidAlertJobData>);
  };
  const field = (payload: Embedded, name: string) =>
    payload.embeds[0]?.toJSON().fields?.find((f) => f.name === name)?.value;
  const stateKey = `pavisie:automod:raidalert:${guildId}:raid-rule`;

  return { ctx, redis, guild, sent, edits, queued, warnings, join, runUpdate, field, stateKey };
}

describe('raid alert: one message per raid', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts a single alert however many joins are flagged', async () => {
    const h = harness('raid-single');

    for (let i = 0; i < 200; i += 1) await h.join();

    expect(h.sent).toHaveLength(1);
    expect(h.edits).toHaveLength(0);
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]?.delay).toBe(RAID_ALERT_UPDATE_INTERVAL_MS);
    expect(await h.redis.hget(h.stateKey, 'joins')).toBe('200');
  });

  it('posts a single alert when the joins arrive at the same moment', async () => {
    const h = harness('raid-concurrent');

    await Promise.all(Array.from({ length: 50 }, () => h.join()));

    expect(h.sent).toHaveLength(1);
    expect(h.queued).toHaveLength(1);
    expect(await h.redis.hget(h.stateKey, 'joins')).toBe('50');
  });

  it('edits that message with the running count, at most once per update', async () => {
    const h = harness('raid-edits');
    for (let i = 0; i < 40; i += 1) await h.join();

    await h.runUpdate();
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]?.messageId).toBe('alert-1');
    expect(h.field(h.edits[0]!.payload, 'Joins flagged')).toBe('40');
    expect(h.field(h.edits[0]!.payload, 'Status')).toContain('In progress');
    // The job queued exactly one follow-up for itself.
    expect(h.queued).toHaveLength(2);

    // Nothing new joined: the next update has nothing to say, so it makes no Discord call at all.
    await h.runUpdate();
    expect(h.edits).toHaveLength(1);
    expect(h.queued).toHaveLength(3);

    for (let i = 0; i < 10; i += 1) await h.join();
    await h.runUpdate();
    expect(h.edits).toHaveLength(2);
    expect(h.field(h.edits[1]!.payload, 'Joins flagged')).toBe('50');
    expect(h.sent).toHaveLength(1);
  });

  it('marks the raid as ended once it has gone quiet, then stops', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('raid-ended');
    for (let i = 0; i < 25; i += 1) await h.join();

    vi.advanceTimersByTime(RAID_ALERT_QUIET_MS - 1_000);
    await h.runUpdate();
    expect(h.field(h.edits[0]!.payload, 'Status')).toContain('In progress');

    vi.advanceTimersByTime(2_000);
    const queuedBefore = h.queued.length;
    await h.runUpdate();

    const last = h.edits[h.edits.length - 1]!;
    expect(last.payload.embeds[0]?.toJSON().title).toContain('(raid ended)');
    expect(h.field(last.payload, 'Status')).toContain('Raid ended');
    expect(h.field(last.payload, 'Joins flagged')).toBe('25');
    // No follow-up job, and the stored state is gone.
    expect(h.queued).toHaveLength(queuedBefore);
    expect(await h.redis.exists(h.stateKey)).toBe(0);
  });

  it('a join during the quiet period keeps the same raid open', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('raid-reopen');
    await h.join();

    vi.advanceTimersByTime(RAID_ALERT_QUIET_MS - 5_000);
    await h.join();
    vi.advanceTimersByTime(10_000);
    await h.runUpdate();

    expect(h.sent).toHaveLength(1);
    expect(h.field(h.edits[0]!.payload, 'Status')).toContain('In progress');
    expect(h.field(h.edits[0]!.payload, 'Joins flagged')).toBe('2');
  });

  it('starts a new alert for the next raid after one has ended', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('raid-second');
    await h.join();
    vi.advanceTimersByTime(RAID_ALERT_QUIET_MS + 1_000);
    await h.runUpdate();

    await h.join();
    await h.join();

    expect(h.sent).toHaveLength(2);
    expect(await h.redis.hget(h.stateKey, 'joins')).toBe('2');
  });

  it('starts a new alert if an earlier raid was never closed (its update job was lost)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('raid-stale');
    for (let i = 0; i < 5; i += 1) await h.join();

    // No update job ever runs. Much later, another raid begins.
    vi.advanceTimersByTime(RAID_ALERT_QUIET_MS * 3 + 1_000);
    await h.join();

    expect(h.sent).toHaveLength(2);
    expect(await h.redis.hget(h.stateKey, 'joins')).toBe('1');
    expect(h.queued).toHaveLength(2);
  });

  it('ignores an update job that belongs to an older raid', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('raid-old-job');
    await h.join();
    const oldJob = h.queued[0]!;
    vi.advanceTimersByTime(RAID_ALERT_QUIET_MS * 3 + 1_000);
    for (let i = 0; i < 3; i += 1) await h.join();

    await raidAlertJob.processor(h.ctx, { data: oldJob.data } as Job<RaidAlertJobData>);

    expect(h.edits).toHaveLength(0);
    expect(await h.redis.hget(h.stateKey, 'joins')).toBe('3');
  });

  it('keeps tracking and closing the raid when the alert cannot be edited', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('raid-edit-fails', { failEdits: true });
    await h.join();
    await h.join();

    await h.runUpdate();
    expect(h.queued).toHaveLength(2);
    expect(h.warnings).toContain('automod: failed to update raid alert');

    vi.advanceTimersByTime(RAID_ALERT_QUIET_MS + 1_000);
    await h.runUpdate();
    expect(await h.redis.exists(h.stateKey)).toBe(0);
  });

  it('warns once, not once per join, when no alert channel is set', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('raid-no-channel', { alertChannelId: null });

    for (let i = 0; i < 30; i += 1) await h.join();

    expect(h.sent).toHaveLength(0);
    expect(h.warnings).toEqual(['automod: alert_staff action configured but no alertChannelId set']);

    // The raid is still closed out and its state removed.
    vi.advanceTimersByTime(RAID_ALERT_QUIET_MS + 1_000);
    await h.runUpdate();
    expect(h.edits).toHaveLength(0);
    expect(await h.redis.exists(h.stateKey)).toBe(0);
  });
});

describe('raid alert: through the join handler', () => {
  const CONFIG: AutomodConfig = {
    dryRun: false,
    alertChannelId: 'alerts',
    quarantineRoleId: null,
    exemptStaff: true,
    defaultTimeoutMs: 600_000,
    raidLockdown: 'quarantine-new-joins',
    raidLockdownMinutes: 15,
  };

  function rule(id: string, config: Record<string, unknown>): AutomodRule {
    return {
      id,
      guildId: 'unused',
      name: id,
      type: config.type,
      enabled: true,
      dryRun: false,
      config,
      actions: [{ type: 'alert_staff' }],
      exemptRoleIds: [],
      exemptChannelIds: [],
      exemptUserIds: [],
      trustedDomains: [],
      cooldownSeconds: 0,
      priority: 0,
      deletedAt: null,
      createdBy: 'mod',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as AutomodRule;
  }

  function joinHarness(guildId: string, rules: AutomodRule[], options: { breakRaidAlert?: boolean } = {}) {
    const sent: unknown[] = [];
    const events: string[] = [];
    const channel = {
      id: 'alerts',
      type: 0,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      send: async (payload: unknown) => {
        sent.push(payload);
        return { id: `alert-${sent.length}` };
      },
    };
    const guild = {
      id: guildId,
      ownerId: 'owner',
      members: { me: { id: 'bot' }, cache: new Map() },
      channels: { fetch: async () => channel },
    };
    const { ctx, redis } = createTestContext({
      config: CONFIG,
      prismaOverrides: {
        automodRule: { findMany: async () => rules },
        automodEvent: {
          create: async (...args: unknown[]) => {
            const { data } = args[0] as { data: { ruleId: string; userId: string } };
            events.push(`${data.ruleId}:${data.userId}`);
            return { id: `event-${events.length}` };
          },
        },
      },
      overrides: { client: { guilds: { cache: new Map([[guildId, guild]]) }, user: { id: 'bot' } } as never },
    });
    if (options.breakRaidAlert) {
      // Only the raid-alert bookkeeping fails; everything else on Redis keeps working.
      redis.eval = (async () => {
        throw new Error('redis script failed');
      }) as never;
    }
    const join = (userId: string) =>
      handleMemberJoin(ctx, {
        id: userId,
        guild,
        user: { id: userId, bot: false, createdAt: new Date(Date.now() - 3_600_000) },
        joinedAt: new Date(),
        roles: { cache: new Map() },
        permissions: { has: () => false },
      } as unknown as GuildMember);
    return { redis, sent, events, join };
  }

  it('records every flagged join but alerts staff once', async () => {
    const raid = rule('join-raid', { type: 'RAID_DETECTION', joinBurstCount: 3, joinBurstWindowSeconds: 60 });
    const h = joinHarness('raid-handler', [raid]);

    for (let i = 0; i < 20; i += 1) await h.join(`raider-${i}`);

    // Joins 3..20 hit the threshold: eighteen events, one alert.
    expect(h.events).toHaveLength(18);
    expect(h.sent).toHaveLength(1);
    expect(await h.redis.get('pavisie:automod:raidlockdown:raid-handler')).toBe('1');
  });

  it('still alerts per member for other join rules', async () => {
    const age = rule('join-age', { type: 'ACCOUNT_AGE', minAccountAgeHours: 24 });
    const h = joinHarness('raid-handler-age', [age]);

    for (let i = 0; i < 4; i += 1) await h.join(`young-${i}`);

    expect(h.events).toHaveLength(4);
    expect(h.sent).toHaveLength(4);
  });

  it('still applies the lockdown when the raid alert itself fails', async () => {
    const raid = rule('join-raid-broken', {
      type: 'RAID_DETECTION',
      joinBurstCount: 2,
      joinBurstWindowSeconds: 60,
    });
    const h = joinHarness('raid-handler-broken', [raid], { breakRaidAlert: true });

    await h.join('raider-a');
    await h.join('raider-b');

    expect(h.events).toHaveLength(1);
    expect(h.sent).toHaveLength(0);
    expect(await h.redis.get('pavisie:automod:raidlockdown:raid-handler-broken')).toBe('1');
  });
});
