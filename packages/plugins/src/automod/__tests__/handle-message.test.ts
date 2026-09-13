import type { Guild, Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { AutomodRule } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import type { AutomodConfig } from '../manifest';
import type { AutomodRuleConfig } from '../schemas';
import { handleMessage } from '../service';

// ioredis-mock shares one in-memory dataset across instances (see window-store-and-cooldowns.test.ts), and both
// the match-claim keys and the frequency windows are keyed by rule id — so every test below uses its own rule id.

const BASE_CONFIG: AutomodConfig = {
  dryRun: false,
  alertChannelId: null,
  quarantineRoleId: null,
  exemptStaff: true,
  defaultTimeoutMs: 600_000,
  raidLockdown: 'none',
  raidLockdownMinutes: 15,
};

function fakeRule(overrides: {
  id: string;
  config: AutomodRuleConfig;
  actions?: { type: string }[];
  dryRun?: boolean;
}): AutomodRule {
  return {
    id: overrides.id,
    guildId: 'g1',
    name: overrides.id,
    type: overrides.config.type,
    enabled: true,
    dryRun: overrides.dryRun ?? false,
    config: overrides.config,
    actions: overrides.actions ?? [{ type: 'ignore' }],
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

const fakeGuild = {
  id: 'g1',
  ownerId: 'owner1',
  members: {
    cache: new Map(),
    // The pipeline wraps this in `.catch(() => null)`; an uncached, unfetchable member is the simplest fixture.
    fetch: async () => {
      throw new Error('member not cached');
    },
    me: null,
  },
} as unknown as Guild;

interface FakeMessage {
  message: Message;
  deleted: () => boolean;
}

function fakeMessage(id: string, content: string): FakeMessage {
  let deleted = false;
  const message = {
    id,
    guildId: 'g1',
    channelId: 'c1',
    author: { id: 'u1', bot: false, system: false },
    webhookId: null,
    guild: fakeGuild,
    member: null,
    channel: { nsfw: false },
    content,
    mentions: { users: new Map(), roles: new Map(), everyone: false },
    attachments: new Map(),
    createdAt: new Date(),
    delete: async () => {
      deleted = true;
    },
  } as unknown as Message;
  return { message, deleted: () => deleted };
}

function contextFor(rules: AutomodRule[], config: AutomodConfig = BASE_CONFIG) {
  const created: { data: Record<string, unknown> }[] = [];
  const { ctx } = createTestContext({
    config,
    intentsEnabled: { messageContent: true },
    prismaOverrides: {
      automodRule: { findMany: async () => rules },
      automodEvent: {
        create: async (...args: unknown[]) => {
          const arg = args[0] as { data: Record<string, unknown> };
          created.push(arg);
          return { id: `event${created.length}` };
        },
      },
    },
  });
  return { ctx, created };
}

const wordFilter = (words: string[]): AutomodRuleConfig => ({
  type: 'WORD_FILTER',
  words,
  wholeWord: true,
  caseSensitive: false,
});

describe('handleMessage — repeat deliveries of the same message', () => {
  it('acts once per rule per message, however many times the message is delivered', async () => {
    const rule = fakeRule({ id: 'claim-rule', config: wordFilter(['bananapants']) });
    const { ctx, created } = contextFor([rule]);
    const { message } = fakeMessage('claim-msg', 'you are a bananapants');

    await handleMessage(ctx, message);
    // What Discord sends when a link in the message finishes unfurling, or on a gateway resume.
    await handleMessage(ctx, message);
    await handleMessage(ctx, message, { reevaluation: true });

    expect(created).toHaveLength(1);
  });

  it('does not punish twice when the same message is delivered twice', async () => {
    const rule = fakeRule({
      id: 'claim-delete-rule',
      config: wordFilter(['bananapants']),
      actions: [{ type: 'delete' }],
    });
    const { ctx, created } = contextFor([rule]);
    const first = fakeMessage('claim-delete-msg', 'bananapants');
    const second = fakeMessage('claim-delete-msg', 'bananapants');

    await handleMessage(ctx, first.message);
    await handleMessage(ctx, second.message);

    expect(first.deleted()).toBe(true);
    expect(second.deleted()).toBe(false);
    expect(created).toHaveLength(1);
  });
});

describe('handleMessage — re-evaluation of an edited message', () => {
  it('does not feed edits into a window-backed rule, so the counter tracks real messages only', async () => {
    const rule = fakeRule({
      id: 'freq-rule',
      config: { type: 'MESSAGE_FREQUENCY', maxMessages: 1, windowSeconds: 60 },
    });
    const { ctx, created } = contextFor([rule]);

    // One real message: the window holds 1, which is inside the allowance.
    await handleMessage(ctx, fakeMessage('freq-m1', 'first').message);
    expect(created).toHaveLength(0);

    // Editing it three times must not look like three more messages.
    for (let i = 0; i < 3; i += 1) {
      await handleMessage(ctx, fakeMessage('freq-m1', `edit ${i}`).message, { reevaluation: true });
    }
    expect(created).toHaveLength(0);

    // The member's *second* real message is the one that exceeds the allowance.
    await handleMessage(ctx, fakeMessage('freq-m2', 'second').message);
    expect(created).toHaveLength(1);
    expect(created[0]?.data.messageId).toBe('freq-m2');
  });

  it('still re-checks content rules on a genuine edit', async () => {
    const rule = fakeRule({ id: 'reeval-word-rule', config: wordFilter(['bananapants']) });
    const { ctx, created } = contextFor([rule]);

    await handleMessage(ctx, fakeMessage('reeval-m1', 'nothing to see').message);
    expect(created).toHaveLength(0);

    await handleMessage(ctx, fakeMessage('reeval-m1', 'now with bananapants').message, {
      reevaluation: true,
    });
    expect(created).toHaveLength(1);
  });
});

describe('handleMessage — dry-run precedence', () => {
  // The live hub deliberately runs with guild-wide dry-run on; this pins that nothing can enforce past it.
  it('keeps a rule inert while guild-wide dry-run is on, even with the rule flag cleared', async () => {
    const rule = fakeRule({
      id: 'guild-dryrun-rule',
      config: wordFilter(['bananapants']),
      actions: [{ type: 'delete' }],
      dryRun: false,
    });
    const { ctx, created } = contextFor([rule], { ...BASE_CONFIG, dryRun: true });
    const { message, deleted } = fakeMessage('guild-dryrun-msg', 'bananapants');

    await handleMessage(ctx, message);

    expect(created).toHaveLength(1);
    expect(created[0]?.data.dryRun).toBe(true);
    expect(deleted()).toBe(false);
  });

  it('keeps a rule inert while its own dry-run is on, even with the guild switch off', async () => {
    const rule = fakeRule({
      id: 'rule-dryrun-rule',
      config: wordFilter(['bananapants']),
      actions: [{ type: 'delete' }],
      dryRun: true,
    });
    const { ctx, created } = contextFor([rule]);
    const { message, deleted } = fakeMessage('rule-dryrun-msg', 'bananapants');

    await handleMessage(ctx, message);

    expect(created).toHaveLength(1);
    expect(created[0]?.data.dryRun).toBe(true);
    expect(deleted()).toBe(false);
  });

  it('acts once both dry-run flags are off', async () => {
    const rule = fakeRule({
      id: 'live-rule',
      config: wordFilter(['bananapants']),
      actions: [{ type: 'delete' }],
      dryRun: false,
    });
    const { ctx, created } = contextFor([rule]);
    const { message, deleted } = fakeMessage('live-msg', 'bananapants');

    await handleMessage(ctx, message);

    expect(created).toHaveLength(1);
    expect(created[0]?.data.dryRun).toBe(false);
    expect(deleted()).toBe(true);
  });
});
