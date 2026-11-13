import type { Job } from 'bullmq';
import type { Guild, Message } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomodRule } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import type { AutomodConfig } from '../manifest';
import {
  MESSAGE_ALERT_INDIVIDUAL_LIMIT,
  MESSAGE_ALERT_JOB_ATTEMPTS,
  MESSAGE_ALERT_QUIET_MS,
  MESSAGE_ALERT_UPDATE_INTERVAL_MS,
  MESSAGE_ALERT_WINDOW_MS,
  messageAlertJob,
  type MessageAlertJobData,
} from '../message-alert';
import { handleMessage } from '../service';

// A burst of matches on a message rule posts at most MESSAGE_ALERT_INDIVIDUAL_LIMIT normal alerts per rule per
// channel per minute, then ONE summary alert that is edited in place. These tests pin that through the real
// message handler, plus the summary's update / close / restart behaviour.
//
// ioredis-mock shares one dataset across instances, so every test uses its own guild id.

interface SentPayload {
  embeds: { toJSON(): { title?: string; fields?: { name: string; value: string }[] } }[];
  components?: unknown[];
}

const CONFIG: AutomodConfig = {
  dryRun: false,
  alertChannelId: 'alerts',
  quarantineRoleId: null,
  exemptStaff: true,
  defaultTimeoutMs: 600_000,
  raidLockdown: 'none',
  raidLockdownMinutes: 15,
};

function wordRule(id: string, options: { dryRun?: boolean } = {}): AutomodRule {
  return {
    id,
    guildId: 'unused',
    name: `Rule ${id}`,
    type: 'WORD_FILTER',
    enabled: true,
    dryRun: options.dryRun ?? false,
    config: { type: 'WORD_FILTER', words: ['bananapants'], wholeWord: true, caseSensitive: false },
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

function harness(
  guildId: string,
  rules: AutomodRule[],
  options: { config?: Partial<AutomodConfig>; failEdits?: boolean; logMessageContent?: boolean } = {},
) {
  const sent: SentPayload[] = [];
  const edits: { messageId: string; payload: SentPayload }[] = [];
  const queued: { data: MessageAlertJobData; jobId: string; delay: number; attempts?: number }[] = [];
  const events: string[] = [];
  const warnings: string[] = [];

  const alertChannel = {
    id: 'alerts',
    type: 0,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload: SentPayload) => {
      sent.push(payload);
      return { id: `alert-${sent.length}` };
    },
    messages: {
      edit: async (messageId: string, payload: SentPayload) => {
        if (options.failEdits) throw new Error('Unknown Message');
        edits.push({ messageId, payload });
      },
    },
  };
  const guild = {
    id: guildId,
    ownerId: 'owner',
    members: {
      me: { id: 'bot' },
      cache: new Map(),
      fetch: async () => {
        throw new Error('member not cached');
      },
    },
    channels: { fetch: async () => alertChannel },
  } as unknown as Guild;

  const { ctx, redis, services } = createTestContext({
    config: { ...CONFIG, ...options.config },
    intentsEnabled: { messageContent: true },
    prismaOverrides: {
      automodRule: { findMany: async () => rules },
      automodEvent: {
        create: async (...args: unknown[]) => {
          const { data } = args[0] as { data: { ruleId: string; userId: string; channelId: string } };
          events.push(`${data.ruleId}:${data.channelId}:${data.userId}`);
          return { id: `event-${events.length}` };
        },
      },
    },
    overrides: {
      client: { guilds: { cache: new Map([[guildId, guild]]) }, user: { id: 'bot' } } as never,
      queue: () =>
        ({
          add: async (
            _name: string,
            data: MessageAlertJobData,
            opts: { jobId: string; delay: number; attempts?: number },
          ) => {
            queued.push({ data, jobId: opts.jobId, delay: opts.delay, attempts: opts.attempts });
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

  if (options.logMessageContent) {
    services.register('host', {
      getGuildConfig: async () => ({ logMessageContent: true }) as never,
    } as never);
  }

  let nextMessage = 0;
  /** Delivers one message that matches the word filter. */
  const send = (options: { userId?: string; channelId?: string } = {}) => {
    nextMessage += 1;
    return handleMessage(ctx, {
      id: `${guildId}-msg-${nextMessage}`,
      guildId,
      channelId: options.channelId ?? 'general',
      author: { id: options.userId ?? 'spammer', bot: false, system: false },
      webhookId: null,
      guild,
      member: null,
      channel: { nsfw: false },
      content: 'you are a bananapants',
      mentions: { users: new Map(), roles: new Map(), everyone: false },
      attachments: new Map(),
      createdAt: new Date(),
      delete: async () => undefined,
    } as unknown as Message);
  };
  /** Runs the most recently queued update job, the way the worker would once its delay has passed. */
  const runUpdate = async () => {
    const next = queued[queued.length - 1];
    if (!next) throw new Error('no update job queued');
    await messageAlertJob.processor(ctx, { data: next.data } as Job<MessageAlertJobData>);
  };
  const field = (payload: SentPayload, name: string) =>
    payload.embeds[0]?.toJSON().fields?.find((f) => f.name === name)?.value;
  const title = (payload: SentPayload) => payload.embeds[0]?.toJSON().title ?? '';
  const summaryKey = (ruleId: string, channelId = 'general') =>
    `pavisie:automod:msgalert:summary:${guildId}:${ruleId}:${channelId}`;

  return { ctx, redis, sent, edits, queued, events, warnings, send, runUpdate, field, title, summaryKey };
}

describe('message alerts: capped per rule per channel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts normal alerts with review buttons up to the limit, then one summary', async () => {
    const h = harness('msg-cap', [wordRule('cap')]);

    for (let i = 0; i < 40; i += 1) await h.send({ userId: `user-${i % 4}` });

    // Every match is still saved on its own.
    expect(h.events).toHaveLength(40);
    expect(h.sent).toHaveLength(MESSAGE_ALERT_INDIVIDUAL_LIMIT + 1);

    const individual = h.sent.slice(0, MESSAGE_ALERT_INDIVIDUAL_LIMIT);
    for (const alert of individual) expect(alert.components).toHaveLength(1);

    const summary = h.sent[MESSAGE_ALERT_INDIVIDUAL_LIMIT]!;
    expect(summary.components ?? []).toHaveLength(0);
    expect(h.title(summary)).toContain('+1 more');
    expect(h.field(summary, 'Channel')).toBe('<#general>');
    expect(h.field(summary, 'Review')).toContain('/automod review');

    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]?.delay).toBe(MESSAGE_ALERT_UPDATE_INTERVAL_MS);
    expect(await h.redis.hget(h.summaryKey('cap'), 'matches')).toBe(
      String(40 - MESSAGE_ALERT_INDIVIDUAL_LIMIT),
    );
  });

  it('posts a single summary when the overflow arrives all at once', async () => {
    const h = harness('msg-concurrent', [wordRule('conc')]);
    for (let i = 0; i < MESSAGE_ALERT_INDIVIDUAL_LIMIT; i += 1) await h.send();

    await Promise.all(Array.from({ length: 30 }, () => h.send()));

    expect(h.sent).toHaveLength(MESSAGE_ALERT_INDIVIDUAL_LIMIT + 1);
    expect(h.queued).toHaveLength(1);
    expect(await h.redis.hget(h.summaryKey('conc'), 'matches')).toBe('30');
  });

  it('counts each channel separately', async () => {
    const h = harness('msg-channels', [wordRule('chan')]);

    for (let i = 0; i < 8; i += 1) await h.send({ channelId: 'general' });
    for (let i = 0; i < 3; i += 1) await h.send({ channelId: 'memes' });

    // general: 5 normal + 1 summary. memes: 3 normal.
    expect(h.sent).toHaveLength(MESSAGE_ALERT_INDIVIDUAL_LIMIT + 1 + 3);
    expect(await h.redis.exists(h.summaryKey('chan', 'memes'))).toBe(0);
  });

  it('counts each rule separately', async () => {
    const h = harness('msg-rules', [wordRule('rule-a'), wordRule('rule-b')]);

    for (let i = 0; i < 7; i += 1) await h.send();

    // Both rules match every message: each gets 5 normal alerts and its own summary.
    expect(h.sent).toHaveLength(2 * (MESSAGE_ALERT_INDIVIDUAL_LIMIT + 1));
    expect(await h.redis.hget(h.summaryKey('rule-a'), 'matches')).toBe('2');
    expect(await h.redis.hget(h.summaryKey('rule-b'), 'matches')).toBe('2');
  });

  it('gives the rule its normal alerts back once the minute is over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('msg-window', [wordRule('win')]);
    for (let i = 0; i < MESSAGE_ALERT_INDIVIDUAL_LIMIT; i += 1) await h.send();
    vi.advanceTimersByTime(MESSAGE_ALERT_WINDOW_MS + 1_000);

    await h.send();

    expect(h.sent).toHaveLength(MESSAGE_ALERT_INDIVIDUAL_LIMIT + 1);
    expect(h.sent[MESSAGE_ALERT_INDIVIDUAL_LIMIT]?.components).toHaveLength(1);
  });

  it('sets the one-minute expiry on the alert counter', async () => {
    const h = harness('msg-ttl', [wordRule('ttl')]);
    await h.send();

    const ttl = await h.redis.pttl('pavisie:automod:msgalert:slots:msg-ttl:ttl:general');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(MESSAGE_ALERT_WINDOW_MS);
  });

  it('edits the summary with the running count and members, at most once per update', async () => {
    const h = harness('msg-edits', [wordRule('edit')]);
    for (let i = 0; i < 25; i += 1) await h.send({ userId: `user-${i % 3}` });

    await h.runUpdate();
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]?.messageId).toBe(`alert-${MESSAGE_ALERT_INDIVIDUAL_LIMIT + 1}`);
    expect(h.field(h.edits[0]!.payload, 'More matches')).toBe('+20');
    expect(h.field(h.edits[0]!.payload, 'Members')).toBe('3');
    expect(h.field(h.edits[0]!.payload, 'Status')).toContain('In progress');
    expect(h.queued).toHaveLength(2);

    // Nothing new: the next update makes no Discord call at all.
    await h.runUpdate();
    expect(h.edits).toHaveLength(1);
    expect(h.queued).toHaveLength(3);

    for (let i = 0; i < 5; i += 1) await h.send({ userId: 'user-new' });
    await h.runUpdate();
    expect(h.edits).toHaveLength(2);
    expect(h.field(h.edits[1]!.payload, 'More matches')).toBe('+25');
    expect(h.field(h.edits[1]!.payload, 'Members')).toBe('4');
    expect(h.sent).toHaveLength(MESSAGE_ALERT_INDIVIDUAL_LIMIT + 1);
  });

  it('marks the summary as ended once it has gone quiet, then stops', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('msg-ended', [wordRule('end')]);
    for (let i = 0; i < 12; i += 1) await h.send();

    vi.advanceTimersByTime(MESSAGE_ALERT_QUIET_MS - 1_000);
    await h.runUpdate();
    expect(h.field(h.edits[0]!.payload, 'Status')).toContain('In progress');

    vi.advanceTimersByTime(2_000);
    const queuedBefore = h.queued.length;
    await h.runUpdate();

    const last = h.edits[h.edits.length - 1]!;
    expect(h.title(last.payload)).toContain('(ended)');
    expect(h.field(last.payload, 'Status')).toContain('Ended');
    expect(h.field(last.payload, 'More matches')).toBe('+7');
    expect(h.queued).toHaveLength(queuedBefore);
    expect(await h.redis.exists(h.summaryKey('end'))).toBe(0);
    expect(await h.redis.exists(`pavisie:automod:msgalert:members:msg-ended:end:general`)).toBe(0);
  });

  it('starts a new summary for the next burst after one has ended', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('msg-second', [wordRule('again')]);
    for (let i = 0; i < 7; i += 1) await h.send();
    vi.advanceTimersByTime(MESSAGE_ALERT_QUIET_MS + 1_000);
    await h.runUpdate();

    // A new minute: the next burst gets its own normal alerts, then a new summary.
    for (let i = 0; i < 7; i += 1) await h.send();

    expect(h.sent).toHaveLength(2 * (MESSAGE_ALERT_INDIVIDUAL_LIMIT + 1));
    expect(h.title(h.sent[h.sent.length - 1]!)).toContain('+1 more');
    expect(await h.redis.hget(h.summaryKey('again'), 'matches')).toBe('2');
  });

  it('keeps tracking and closing the summary when it cannot be edited', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness('msg-edit-fails', [wordRule('fail')], { failEdits: true });
    for (let i = 0; i < 8; i += 1) await h.send();

    await h.runUpdate();
    expect(h.warnings).toContain('automod: failed to update message alert summary');
    expect(h.queued).toHaveLength(2);

    vi.advanceTimersByTime(MESSAGE_ALERT_QUIET_MS + 1_000);
    await h.runUpdate();
    expect(await h.redis.exists(h.summaryKey('fail'))).toBe(0);
  });

  it('retries an update that fails outright', async () => {
    const h = harness('msg-retry', [wordRule('retry')]);
    for (let i = 0; i < 8; i += 1) await h.send();
    expect(h.queued[0]?.attempts).toBe(MESSAGE_ALERT_JOB_ATTEMPTS);

    const hgetall = h.redis.hgetall.bind(h.redis);
    h.redis.hgetall = (async () => {
      throw new Error('redis unavailable');
    }) as never;
    await expect(h.runUpdate()).rejects.toThrow('redis unavailable');
    expect(h.queued).toHaveLength(1);

    h.redis.hgetall = hgetall;
    await h.runUpdate();
    expect(h.edits).toHaveLength(1);
    expect(h.queued).toHaveLength(2);
  });

  it('falls back to a normal alert when the limit cannot be checked', async () => {
    const h = harness('msg-redis-down', [wordRule('down')]);
    const evalScript = h.redis.eval.bind(h.redis);
    h.redis.eval = (async (script: string, ...args: unknown[]) => {
      if (script.includes("'INCR'")) throw new Error('redis unavailable');
      return evalScript(script, ...(args as [number]));
    }) as never;

    for (let i = 0; i < 8; i += 1) await h.send();

    expect(h.sent).toHaveLength(8);
    for (const alert of h.sent) expect(alert.components).toHaveLength(1);
    expect(h.warnings).toContain(
      'automod: could not check the message alert limit; posting the alert anyway',
    );
  });

  it('marks a dry-run summary as such', async () => {
    const h = harness('msg-dry', [wordRule('dry', { dryRun: true })]);
    for (let i = 0; i < 6; i += 1) await h.send();

    expect(h.title(h.sent[MESSAGE_ALERT_INDIVIDUAL_LIMIT]!)).toMatch(/^\[DRY RUN\] /);
  });

  it('never puts message text in the summary, even when content logging is on', async () => {
    const h = harness('msg-no-content', [wordRule('content')], { logMessageContent: true });
    for (let i = 0; i < 6; i += 1) await h.send();

    // The admin opted in, so the normal alerts do quote the message...
    expect(JSON.stringify(h.sent[0]!.embeds[0]!.toJSON())).toContain('bananapants');

    const summary = JSON.stringify(h.sent[MESSAGE_ALERT_INDIVIDUAL_LIMIT]!.embeds[0]!.toJSON());
    expect(summary).not.toContain('bananapants');
  });

  it('warns about the missing alert channel without counting anything', async () => {
    const h = harness('msg-no-channel', [wordRule('none')], { config: { alertChannelId: null } });
    for (let i = 0; i < 8; i += 1) await h.send();

    expect(h.sent).toHaveLength(0);
    expect(h.queued).toHaveLength(0);
    expect(h.events).toHaveLength(8);
    expect(await h.redis.exists('pavisie:automod:msgalert:slots:msg-no-channel:none:general')).toBe(0);
  });
});
