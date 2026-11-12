import type { Guild, Message } from 'discord.js';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { AutomodRule } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import type { AutomodConfig } from '../manifest';
import {
  AUTOMOD_RULES_CHANGED_CHANNEL,
  parseRulesChangedMessage,
  publishAutomodRulesChanged,
  subscribeAutomodRulesChanged,
} from '../rule-sync';
import { handleMessage, invalidateRuleCache, startRuleSync } from '../service';

// A rule edited in the dashboard is written by the API process. These tests pin that the bot hears about it over
// Redis and stops using its cached copy at once, instead of when that copy expires.

/** Lets the mock's pub/sub delivery (which is asynchronous) run. */
const delivered = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('rule-change announcements', () => {
  it('delivers a published change to a subscriber', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const heard: string[] = [];
    const subscription = await subscribeAutomodRulesChanged(redis, (guildId) => heard.push(guildId));

    // Published as another process would: same channel, a different origin.
    await redis.publish(
      AUTOMOD_RULES_CHANGED_CHANNEL,
      JSON.stringify({ guildId: 'sync-guild', origin: 'api' }),
    );
    await delivered();

    expect(heard).toEqual(['sync-guild']);
    await subscription.close();
  });

  it('ignores its own announcements, malformed messages, and other channels', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const heard: string[] = [];
    const subscription = await subscribeAutomodRulesChanged(redis, (guildId) => heard.push(guildId));

    expect(await publishAutomodRulesChanged(redis, 'sync-own')).toBe(true);
    await redis.publish(AUTOMOD_RULES_CHANGED_CHANNEL, 'not json');
    await redis.publish(AUTOMOD_RULES_CHANGED_CHANNEL, JSON.stringify({ origin: 'api' }));
    await redis.publish(AUTOMOD_RULES_CHANGED_CHANNEL, JSON.stringify({ guildId: 42, origin: 'api' }));
    await redis.publish('pavisie:something-else', JSON.stringify({ guildId: 'sync-other', origin: 'api' }));
    await delivered();

    expect(heard).toEqual([]);
    await subscription.close();
  });

  it('parses only well-formed messages from other processes', () => {
    expect(parseRulesChangedMessage(JSON.stringify({ guildId: 'g', origin: 'them' }), 'me')).toBe('g');
    expect(parseRulesChangedMessage(JSON.stringify({ guildId: 'g', origin: 'me' }), 'me')).toBeNull();
    expect(parseRulesChangedMessage(JSON.stringify({ guildId: '', origin: 'them' }), 'me')).toBeNull();
    expect(
      parseRulesChangedMessage(JSON.stringify({ guildId: 'x'.repeat(65), origin: 'them' }), 'me'),
    ).toBeNull();
    expect(parseRulesChangedMessage('null', 'me')).toBeNull();
    expect(parseRulesChangedMessage('{', 'me')).toBeNull();
  });

  it('reports failure instead of throwing when Redis cannot publish', async () => {
    const redis = new RedisMock() as unknown as Redis;
    vi.spyOn(redis, 'publish').mockRejectedValue(new Error('redis unavailable'));

    await expect(publishAutomodRulesChanged(redis, 'sync-down')).resolves.toBe(false);
  });
});

describe('a rule change made elsewhere reaches the bot at once', () => {
  const CONFIG: AutomodConfig = {
    dryRun: false,
    alertChannelId: null,
    quarantineRoleId: null,
    exemptStaff: true,
    defaultTimeoutMs: 600_000,
    raidLockdown: 'none',
    raidLockdownMinutes: 15,
  };

  function wordRule(id: string, guildId: string, word: string): AutomodRule {
    const config = { type: 'WORD_FILTER', words: [word], wholeWord: true, caseSensitive: false };
    return {
      id,
      guildId,
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

  function harness(guildId: string, initial: AutomodRule[]) {
    const state = { rules: initial, reads: 0 };
    const flagged: string[] = [];
    const { ctx, redis } = createTestContext({
      config: CONFIG,
      intentsEnabled: { messageContent: true },
      prismaOverrides: {
        automodRule: {
          findMany: async () => {
            state.reads += 1;
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
    const guild = {
      id: guildId,
      ownerId: 'owner1',
      members: {
        cache: new Map(),
        fetch: async () => {
          throw new Error('member not cached');
        },
        me: null,
      },
    } as unknown as Guild;
    const send = (id: string, content: string) =>
      handleMessage(ctx, {
        id,
        guildId,
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
      } as unknown as Message);
    return { ctx, redis, state, flagged, send };
  }

  it('stops applying a rule the dashboard just deleted, without waiting for the cache to expire', async () => {
    const h = harness('sync-delete', [wordRule('sync-delete-rule', 'sync-delete', 'badword')]);
    const subscription = await startRuleSync(h.ctx);
    await h.send('sync-delete-1', 'badword');
    expect(h.flagged).toEqual(['sync-delete-rule:sync-delete-1']);

    // The API deletes the rule and announces it.
    h.state.rules = [];
    await h.redis.publish(
      AUTOMOD_RULES_CHANGED_CHANNEL,
      JSON.stringify({ guildId: 'sync-delete', origin: 'api' }),
    );
    await delivered();
    await h.send('sync-delete-2', 'badword');

    expect(h.state.reads).toBe(2);
    expect(h.flagged).toEqual(['sync-delete-rule:sync-delete-1']);
    await subscription.close();
  });

  it('starts applying a rule the dashboard just created', async () => {
    const h = harness('sync-create', []);
    const subscription = await startRuleSync(h.ctx);
    await h.send('sync-create-1', 'newword');
    expect(h.flagged).toEqual([]);

    h.state.rules = [wordRule('sync-create-rule', 'sync-create', 'newword')];
    await h.redis.publish(
      AUTOMOD_RULES_CHANGED_CHANNEL,
      JSON.stringify({ guildId: 'sync-create', origin: 'api' }),
    );
    await delivered();
    await h.send('sync-create-2', 'newword');

    expect(h.flagged).toEqual(['sync-create-rule:sync-create-2']);
    await subscription.close();
  });

  it("leaves another guild's cached rules alone", async () => {
    const h = harness('sync-other-a', [wordRule('sync-other-rule', 'sync-other-a', 'badword')]);
    const subscription = await startRuleSync(h.ctx);
    await h.send('sync-other-1', 'badword');

    await h.redis.publish(
      AUTOMOD_RULES_CHANGED_CHANNEL,
      JSON.stringify({ guildId: 'sync-other-b', origin: 'api' }),
    );
    await delivered();
    await h.send('sync-other-2', 'badword');

    expect(h.state.reads).toBe(1);
    await subscription.close();
  });

  it("a rule command's own change is re-read once, not twice", async () => {
    const h = harness('sync-self', [wordRule('sync-self-rule', 'sync-self', 'badword')]);
    const subscription = await startRuleSync(h.ctx);
    await h.send('sync-self-1', 'badword');

    // What the bot's rule commands call. It announces the change for other processes; this process must not
    // then treat its own announcement as a second change.
    invalidateRuleCache(h.ctx, 'sync-self');
    await h.send('sync-self-2', 'badword');
    await delivered();
    await h.send('sync-self-3', 'badword');

    expect(h.state.reads).toBe(2);
    await subscription.close();
  });
});
