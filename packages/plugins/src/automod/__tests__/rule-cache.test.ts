import type { Guild, Message } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomodRule } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import type { AutomodConfig } from '../manifest';
import type { AutomodRuleConfig } from '../schemas';
import { handleMessage, invalidateRuleCache } from '../service';

// A guild's rules are read once and reused for a short time, instead of once per message. These tests pin the
// three things that keeps safe: the reuse itself, that a rule change made through the bot applies at once, and
// that a stale or failed read can never stick.

const CONFIG: AutomodConfig = {
  dryRun: false,
  alertChannelId: null,
  quarantineRoleId: null,
  exemptStaff: true,
  defaultTimeoutMs: 600_000,
  raidLockdown: 'none',
  raidLockdownMinutes: 15,
};

function wordRule(id: string, word: string): AutomodRule {
  const config: AutomodRuleConfig = {
    type: 'WORD_FILTER',
    words: [word],
    wholeWord: true,
    caseSensitive: false,
  };
  return {
    id,
    guildId: 'g1',
    name: id,
    type: config.type,
    enabled: true,
    dryRun: false,
    config,
    actions: [{ type: 'ignore' }],
    exemptRoleIds: [],
    exemptChannelIds: [],
    exemptUserIds: [],
    trustedDomains: [],
    cooldownSeconds: 0,
    priority: 0,
    deletedAt: null,
    createdBy: 'mod1',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AutomodRule;
}

const guild = {
  id: 'g1',
  ownerId: 'owner1',
  members: {
    cache: new Map(),
    fetch: async () => {
      throw new Error('member not cached');
    },
    me: null,
  },
} as unknown as Guild;

function message(id: string, content: string): Message {
  return {
    id,
    guildId: 'g1',
    channelId: 'c1',
    author: { id: 'u1', bot: false, system: false },
    webhookId: null,
    guild,
    member: null,
    channel: { nsfw: false },
    content,
    mentions: { users: new Map(), roles: new Map(), everyone: false },
    attachments: new Map(),
    createdAt: new Date(),
    delete: async () => undefined,
  } as unknown as Message;
}

/** A context whose rule list can be swapped mid-test, counting how often it is read and what gets flagged. */
function harness(initial: AutomodRule[]) {
  const state = { rules: initial, reads: 0, failNextRead: false };
  const flagged: string[] = [];
  const { ctx } = createTestContext({
    config: CONFIG,
    intentsEnabled: { messageContent: true },
    prismaOverrides: {
      automodRule: {
        findMany: async () => {
          state.reads += 1;
          if (state.failNextRead) {
            state.failNextRead = false;
            throw new Error('database unavailable');
          }
          return state.rules;
        },
      },
      automodEvent: {
        create: async (...args: unknown[]) => {
          const { data } = args[0] as { data: { ruleId: string; messageId: string } };
          flagged.push(`${data.ruleId}:${data.messageId}`);
          return { id: `event${flagged.length}` };
        },
      },
    },
  });
  return { ctx, state, flagged };
}

describe('automod rule cache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the rules once for a burst of messages', async () => {
    const { ctx, state, flagged } = harness([wordRule('cache-burst', 'badword')]);

    await handleMessage(ctx, message('cache-burst-1', 'a badword here'));
    await handleMessage(ctx, message('cache-burst-2', 'nothing wrong'));
    await handleMessage(ctx, message('cache-burst-3', 'badword again'));

    expect(state.reads).toBe(1);
    expect(flagged).toEqual(['cache-burst:cache-burst-1', 'cache-burst:cache-burst-3']);
  });

  it('shares one read between messages that arrive at the same moment', async () => {
    const { ctx, state, flagged } = harness([wordRule('cache-concurrent', 'badword')]);

    await Promise.all(
      Array.from({ length: 25 }, (_, i) => handleMessage(ctx, message(`cache-concurrent-${i}`, 'badword'))),
    );

    expect(state.reads).toBe(1);
    expect(flagged).toHaveLength(25);
  });

  it('applies a rule change at once when the cache is invalidated', async () => {
    const { ctx, state, flagged } = harness([wordRule('cache-edit-old', 'oldword')]);
    await handleMessage(ctx, message('cache-edit-1', 'oldword'));

    // What the rule commands do after writing: swap the stored rules, then drop the cached copy.
    state.rules = [wordRule('cache-edit-new', 'newword')];
    invalidateRuleCache(ctx, 'g1');
    await handleMessage(ctx, message('cache-edit-2', 'oldword'));
    await handleMessage(ctx, message('cache-edit-3', 'newword'));

    expect(state.reads).toBe(2);
    expect(flagged).toEqual(['cache-edit-old:cache-edit-1', 'cache-edit-new:cache-edit-3']);
  });

  it('picks up a change made elsewhere once the cached copy expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { ctx, state, flagged } = harness([wordRule('cache-ttl-old', 'oldword')]);
    await handleMessage(ctx, message('cache-ttl-1', 'oldword'));

    // A dashboard edit: the stored rules change but nothing tells this process.
    state.rules = [];
    vi.advanceTimersByTime(1_000);
    await handleMessage(ctx, message('cache-ttl-2', 'oldword'));
    expect(state.reads).toBe(1);

    vi.advanceTimersByTime(1_500);
    await handleMessage(ctx, message('cache-ttl-3', 'oldword'));
    expect(state.reads).toBe(2);
    // The deleted rule fired for the message inside the window and never after it.
    expect(flagged).toEqual(['cache-ttl-old:cache-ttl-1', 'cache-ttl-old:cache-ttl-2']);
  });

  it('does not keep a failed read: the next message tries again', async () => {
    const { ctx, state, flagged } = harness([wordRule('cache-fail', 'badword')]);
    state.failNextRead = true;

    await expect(handleMessage(ctx, message('cache-fail-1', 'badword'))).rejects.toThrow(
      'database unavailable',
    );
    await handleMessage(ctx, message('cache-fail-2', 'badword'));

    expect(state.reads).toBe(2);
    expect(flagged).toEqual(['cache-fail:cache-fail-2']);
  });

  it('keeps each guild context separate', async () => {
    const first = harness([wordRule('cache-iso-a', 'badword')]);
    const second = harness([]);

    await handleMessage(first.ctx, message('cache-iso-1', 'badword'));
    await handleMessage(second.ctx, message('cache-iso-2', 'badword'));

    expect(first.flagged).toEqual(['cache-iso-a:cache-iso-1']);
    expect(second.flagged).toEqual([]);
  });
});
