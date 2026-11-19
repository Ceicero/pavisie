import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createTestContext } from '../../sdk/testing';
import type { AiCompleteInput, AiCompleteResult, AiService, ModerationService } from '../../sdk';
import type { CommandContext } from '../../sdk';
import { command as modAssistCommand } from '../commands/mod-assist';
import en from '../locales/en.json';

/** Looks a dotted key (e.g. `errors.caseNotFound`) up in the plugin's real `en.json`, doing `{var}` interpolation — a closer stand-in for the real bound `t` than an identity function, since this test asserts on the actual reply text. */
function realT(key: string, vars?: Record<string, string | number>): string {
  const parts = key.split('.');
  let node: unknown = en;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }
  if (typeof node !== 'string') return key;
  let out = node;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
}

interface FakeInteractionOptions {
  caseNumber?: number | null;
  userId?: string | null;
  context?: string | null;
}

function buildFakeInteraction(opts: FakeInteractionOptions) {
  const editReplyCalls: unknown[] = [];
  const deferReplyCalls: unknown[] = [];

  const interaction = {
    user: { id: 'moderator-1' },
    options: {
      getInteger: (name: string) => (name === 'case-number' ? (opts.caseNumber ?? null) : null),
      getUser: (name: string) => (name === 'user' && opts.userId ? { id: opts.userId } : null),
      getString: (name: string) => (name === 'context' ? (opts.context ?? null) : null),
    },
    deferReply: vi.fn(async (payload: unknown) => {
      deferReplyCalls.push(payload);
    }),
    editReply: vi.fn(async (payload: unknown) => {
      editReplyCalls.push(payload);
    }),
  };

  return {
    interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
    editReplyCalls,
    deferReplyCalls,
  };
}

function buildFakeAiService(response: Partial<AiCompleteResult> = {}): {
  service: AiService;
  calls: AiCompleteInput[];
} {
  const calls: AiCompleteInput[] = [];
  const service: AiService = {
    complete: vi.fn(async (input: AiCompleteInput) => {
      calls.push(input);
      return {
        text: 'Consider a timeout given the repeated warnings.',
        promptTokens: 50,
        completionTokens: 20,
        model: 'test-model',
        provider: 'openai',
        ...response,
      };
    }),
    test: vi.fn(async () => ({ ok: true })),
  };
  return { service, calls };
}

/** Records every method call so the test can assert `mod-assist` never invokes an action method (warn/timeout/kick/ban/createCase). */
function buildFakeModerationService(overrides: Partial<ModerationService> = {}): {
  service: ModerationService;
  calledMethods: string[];
} {
  const calledMethods: string[] = [];
  const track =
    <T extends unknown[], R>(name: string, impl: (...args: T) => R) =>
    (...args: T): R => {
      calledMethods.push(name);
      return impl(...args);
    };

  const service: ModerationService = {
    createCase: track('createCase', (async () => {
      throw new Error('mod-assist must never call createCase');
    }) as never),
    warn: track('warn', (async () => {
      throw new Error('mod-assist must never call warn');
    }) as never),
    timeout: track('timeout', (async () => {
      throw new Error('mod-assist must never call timeout');
    }) as never),
    getCase: track(
      'getCase',
      overrides.getCase ??
        (async () =>
          ({
            id: 'case-1',
            guildId: 'g1',
            caseNumber: 7,
            targetId: 'user-99',
            type: 'WARN',
            reason: 'spam',
          }) as never),
    ),
    listCases: track(
      'listCases',
      overrides.listCases ??
        (async () => ({
          items: [
            { type: 'WARN', reason: 'spam' },
            { type: 'WARN', reason: 'more spam' },
            { type: 'TIMEOUT', reason: null },
          ] as never,
          nextCursor: null,
        })),
    ),
    openAppeal: track('openAppeal', (async () => {
      throw new Error('mod-assist must never open an appeal');
    }) as never),
    getCaseByNumber: track('getCaseByNumber', (async () => null) as never),
    exportCases: track('exportCases', (async () => {
      throw new Error('mod-assist must never export cases');
    }) as never),
    withBanLease: track('withBanLease', (async () => {
      throw new Error('mod-assist must never ban');
    }) as never),
  };

  return { service, calledMethods };
}

function buildCommandContext(
  base: ReturnType<typeof createTestContext>,
  interaction: ChatInputCommandInteraction<'cached'>,
): CommandContext {
  return {
    interaction,
    ctx: base.ctx,
    guildId: 'g1',
    staffLevel: 'moderator',
    locale: 'en' as CommandContext['locale'],
    t: realT,
    config: async <T = unknown>() => ({ userCooldownSeconds: 0 }) as T,
  };
}

describe('/mod-assist', () => {
  it('looks up case history by user and never calls a moderation action method', async () => {
    const testContext = createTestContext();
    const { service: moderationService, calledMethods } = buildFakeModerationService();
    const { service: aiService, calls: aiCalls } = buildFakeAiService();
    testContext.services.register('moderation', moderationService);
    testContext.services.register('ai', aiService);

    const { interaction, editReplyCalls } = buildFakeInteraction({ userId: 'user-42' });
    const c = buildCommandContext(testContext, interaction);

    await modAssistCommand.execute(c);

    expect(calledMethods).toContain('listCases');
    expect(calledMethods).not.toContain('createCase');
    expect(calledMethods).not.toContain('warn');
    expect(calledMethods).not.toContain('timeout');
    expect(calledMethods).not.toContain('openAppeal');
    expect(calledMethods).not.toContain('exportCases');
    expect(calledMethods).not.toContain('withBanLease');

    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0].command).toBe('mod-assist');
    expect(editReplyCalls).toHaveLength(1);
  });

  it('resolves the target from a case number when no user is given', async () => {
    const testContext = createTestContext();
    const { service: moderationService, calledMethods } = buildFakeModerationService();
    const { service: aiService } = buildFakeAiService();
    testContext.services.register('moderation', moderationService);
    testContext.services.register('ai', aiService);

    const { interaction } = buildFakeInteraction({ caseNumber: 7 });
    const c = buildCommandContext(testContext, interaction);

    await modAssistCommand.execute(c);

    expect(calledMethods).toContain('getCase');
    expect(calledMethods).toContain('listCases');
    expect(calledMethods).not.toContain('createCase');
  });

  it('requires either a case number or a user', async () => {
    const testContext = createTestContext();
    const { service: moderationService } = buildFakeModerationService();
    const { service: aiService } = buildFakeAiService();
    testContext.services.register('moderation', moderationService);
    testContext.services.register('ai', aiService);

    const { interaction } = buildFakeInteraction({});
    const c = buildCommandContext(testContext, interaction);

    await expect(modAssistCommand.execute(c)).rejects.toThrow();
  });

  it('the reply text never claims the AI already performed an action', async () => {
    const testContext = createTestContext();
    const { service: moderationService } = buildFakeModerationService();
    const { service: aiService } = buildFakeAiService({ text: 'Suggest a timeout of 1 hour.' });
    testContext.services.register('moderation', moderationService);
    testContext.services.register('ai', aiService);

    const { interaction, editReplyCalls } = buildFakeInteraction({ userId: 'user-42' });
    const c = buildCommandContext(testContext, interaction);

    await modAssistCommand.execute(c);

    const reply = JSON.stringify(editReplyCalls[0]).toLowerCase();
    expect(reply).toContain('suggestion only');
  });
});
