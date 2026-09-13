import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import type { PrismaClient } from '@entrophy/database';
import { registerPluginLocales } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { createEnforcerService } from '../service';
import type { EnforcerConfig } from '../manifest';
import type { ModerationService } from '../../sdk/services';
import en from '../locales/en.json';

// This file imports `service.ts` directly, not `index.ts`, so nothing else registers the enforcer locale
// bundle — mirror the one `registerPluginLocales('enforcer', { en })` call `index.ts` makes at module load, so
// `ctx.t('decide.actionAppliedRecordingFailed')` resolves exactly the way it does in the running bot.
const enforcerT = registerPluginLocales('enforcer', { en });

function defaultConfig(overrides: Partial<EnforcerConfig> = {}): EnforcerConfig {
  return {
    ledgerChannelId: null,
    ledgerVisibility: 'staff',
    flagChannelId: null,
    muteRoleId: null,
    captureContext: true,
    contextBefore: 5,
    contextAfter: 3,
    excerptMaxChars: 300,
    autoFlagEnabled: true,
    exemptStaff: true,
    aiAssist: false,
    dmOnAction: true,
    defaultTimeoutMinutes: 60,
    defaultMuteMinutes: null,
    requireReasonOn: ['kick', 'ban'],
    allowedDecisions: ['warn', 'timeout', 'mute', 'kick', 'ban', 'dismiss'],
    banDeleteMessageSeconds: 0,
    ...overrides,
  };
}

interface FakeRecord {
  id: string;
  guildId: string;
  recordNumber: number;
  status: string;
  userId: string;
  flagMessageId: string | null;
  policyId: string | null;
  policyName: string | null;
  channelId: string | null;
  messageId: string | null;
  messageJumpUrl: string | null;
  excerpt: string | null;
  source: string;
  createdAt: Date;
}

function baseRecord(overrides: Partial<FakeRecord> = {}): FakeRecord {
  return {
    id: 'rec-1',
    guildId: 'g1',
    recordNumber: 1,
    status: 'PENDING',
    userId: 'member-1',
    flagMessageId: null,
    policyId: null,
    policyName: null,
    channelId: null,
    messageId: null,
    messageJumpUrl: null,
    excerpt: null,
    source: 'AUTO',
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Actor + target both resolve as real members and the Discord `member.timeout(...)` call itself succeeds — the
 * point of this test is that the DATABASE write fails AFTER that, not that the Discord action fails.
 */
function fakeClient(): Client<true> {
  const members: Record<string, { highestRolePosition: number }> = {
    'mod-1': { highestRolePosition: 50 },
    'member-1': { highestRolePosition: 5 },
  };
  const guild = {
    id: 'g1',
    ownerId: 'owner-1',
    members: {
      me: { id: 'bot-1', user: { bot: true }, roles: { highest: { position: 1000 } } },
      fetch: (userId: string) => {
        const spec = members[userId];
        if (!spec) return Promise.reject(new Error('not found'));
        return Promise.resolve({
          id: userId,
          user: { bot: false, send: () => Promise.resolve(undefined) },
          roles: { highest: { position: spec.highestRolePosition } },
          timeout: () => Promise.resolve(undefined),
        });
      },
    },
    channels: { fetch: () => Promise.resolve(null) },
  };
  return { guilds: { fetch: async () => guild } } as unknown as Client<true>;
}

/**
 * The FLAG record is readable, but every write inside `decide()`'s own `$transaction` fails — simulating a
 * database error striking only AFTER the (already-mocked-successful) Discord timeout + ModerationCase, exactly
 * the window BUG 1 closes.
 */
function fakeFailingPrisma(record: FakeRecord): PrismaClient {
  return {
    $transaction: () => Promise.reject(new Error('connection terminated unexpectedly')),
    enforcerRecord: {
      findFirst: () => Promise.resolve({ ...record }),
    },
  } as unknown as PrismaClient;
}

function fakeModeration(): ModerationService {
  const timeoutCase = { id: 'case-1', caseNumber: 1 };
  return {
    createCase: vi.fn(async () => timeoutCase as never),
    warn: vi.fn(async () => timeoutCase as never),
    timeout: vi.fn(async () => timeoutCase as never),
    getCase: async () => null,
    listCases: async () => ({ items: [], nextCursor: null }),
    openAppeal: async () => ({ appealId: 'appeal-1' }),
    getCaseByNumber: async () => null,
    exportCases: async () => ({ csv: '', count: 0 }),
  };
}

describe('EnforcerService.decide — database failure after a successful Discord action (BUG 1)', () => {
  it('surfaces a distinct "applied but not recorded" message, not the generic error, and logs at error level', async () => {
    const record = baseRecord();
    const errorLogs: { context: unknown; message: unknown }[] = [];
    const logger = {
      error: (context: unknown, message: unknown) => errorLogs.push({ context, message }),
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      child: () => logger,
    };

    const { ctx } = createTestContext({
      config: defaultConfig(),
      overrides: {
        prisma: fakeFailingPrisma(record),
        client: fakeClient(),
        t: enforcerT,
        logger: logger as never,
      },
    });
    ctx.services.register('moderation', fakeModeration());
    const service = createEnforcerService(ctx);

    let caught: unknown;
    try {
      await service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'TIMEOUT',
        moderatorId: 'mod-1',
        reason: 'test reason',
        source: 'bot',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // The distinct message: applied, not recorded, do not retry.
    expect(message).toMatch(/applied on discord/i);
    expect(message).toMatch(/do not retry/i);
    // Never the generic fallback — that's exactly what invites a moderator to click again and double-apply.
    expect(message).not.toBe('Something went wrong. Please try again.');

    // Logged at error level with enough to investigate (guild, record, decision).
    expect(errorLogs).toHaveLength(1);
    expect(String(errorLogs[0].message)).toMatch(
      /decision database write failed after the discord action already succeeded/i,
    );
    expect(errorLogs[0].context).toMatchObject({ guildId: 'g1', recordId: 'rec-1', decision: 'TIMEOUT' });
  });
});
