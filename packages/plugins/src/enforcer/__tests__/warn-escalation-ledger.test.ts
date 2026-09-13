import { ChannelType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import type { PrismaClient } from '@entrophy/database';
import { createTestContext } from '../../sdk/testing';
import { createEnforcerService } from '../service';
import type { EnforcerConfig } from '../manifest';
import type { ModerationService } from '../../sdk/services';

function defaultConfig(overrides: Partial<EnforcerConfig> = {}): EnforcerConfig {
  return {
    ledgerChannelId: 'ledger-1',
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

/** Same shape as `decision.test.ts`'s `makeFakePrisma`, plus a `created` list so escalation-record assertions
 * can see every `EnforcerRecord` written — both the WARN decision's (inside `decide()`'s transaction) and the
 * escalation's (the plain, non-transactional `recordEscalatedAction` write). */
function makeFakePrisma(record: FakeRecord) {
  let recordNumberSeq = 1000;
  const created: Record<string, unknown>[] = [];
  const enforcerRecord = {
    findFirst: () => Promise.resolve({ ...record }),
    aggregate: () => Promise.resolve({ _max: { recordNumber: recordNumberSeq } }),
    create: (args: { data: Record<string, unknown> }) => {
      recordNumberSeq += 1;
      const row = {
        id: `rec-${recordNumberSeq}`,
        recordNumber: recordNumberSeq,
        createdAt: new Date(),
        ...args.data,
      };
      created.push(row);
      return Promise.resolve(row);
    },
    update: (args: { data: Partial<FakeRecord> }) => {
      Object.assign(record, args.data);
      return Promise.resolve({ ...record });
    },
  };
  const prisma = {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ enforcerRecord }),
    enforcerRecord,
    moderationCase: { updateMany: () => Promise.resolve({ count: 0 }) },
  };
  return { prisma: prisma as unknown as PrismaClient, created };
}

interface FakeChannel {
  id: string;
  type: ChannelType;
  send: ReturnType<typeof vi.fn>;
}

function fakeLedgerChannel(): FakeChannel {
  return { id: 'ledger-1', type: ChannelType.GuildText, send: vi.fn(async () => ({ id: 'msg-1' })) };
}

function fakeClient(channel: FakeChannel): Client<true> {
  const guild = {
    id: 'g1',
    members: {
      // Actor resolves (WARN's `guardTarget` needs it); target does not — DM/hierarchy simply skip, same as
      // "target already left" in decision.test.ts.
      fetch: (userId: string) =>
        userId === 'mod-1'
          ? Promise.resolve({ id: 'mod-1', user: { bot: false }, roles: { highest: { position: 100 } } })
          : Promise.reject(new Error('not found')),
    },
    channels: {
      fetch: (id: string) => Promise.resolve(id === channel.id ? channel : null),
    },
  };
  return { guilds: { fetch: async () => guild } } as unknown as Client<true>;
}

/** `moderation.warn()`'s widened return — the runtime shape `enforcer/service.ts` reads via `created.escalation`. */
function fakeModerationWithEscalation(): ModerationService {
  return {
    createCase: vi.fn(async () => ({ id: 'case-x', caseNumber: 99 }) as never),
    warn: vi.fn(async () => ({
      id: 'warn-case-1',
      caseNumber: 41,
      escalation: {
        rule: { warnings: 3, action: 'timeout', durationMs: 3_600_000 },
        case: { id: 'esc-case-1', caseNumber: 42, guildId: 'g1', targetId: 'member-1' },
      },
    })) as never,
    timeout: vi.fn(async () => ({ id: 'case-x', caseNumber: 99 }) as never),
    getCase: async () => null,
    listCases: async () => ({ items: [], nextCursor: null }),
    openAppeal: async () => ({ appealId: 'appeal-1' }),
    getCaseByNumber: async () => null,
    exportCases: async () => ({ csv: '', count: 0 }),
  };
}

describe('EnforcerService.decide — WARN escalation reaches the ledger (BUG 4)', () => {
  it('writes a second DECISION record and a second ledger post for the auto-escalated action', async () => {
    const record = baseRecord();
    const { prisma, created } = makeFakePrisma(record);
    const channel = fakeLedgerChannel();
    const { ctx } = createTestContext({
      config: defaultConfig(),
      overrides: { prisma, client: fakeClient(channel) },
    });
    ctx.services.register('moderation', fakeModerationWithEscalation());
    const service = createEnforcerService(ctx);

    await service.decide({
      guildId: 'g1',
      recordId: 'rec-1',
      decision: 'WARN',
      moderatorId: 'mod-1',
      reason: 'first offense',
      source: 'bot',
    });

    // Two DECISION records: the WARN itself, and the escalated TIMEOUT — both linked to the same flag.
    expect(created).toHaveLength(2);
    const [warnDecision, escalationDecision] = created;

    expect(warnDecision).toMatchObject({
      kind: 'DECISION',
      decision: 'WARN',
      parentRecordId: 'rec-1',
      caseId: 'warn-case-1',
    });

    expect(escalationDecision).toMatchObject({
      kind: 'DECISION',
      status: 'ACTIONED',
      decision: 'TIMEOUT',
      parentRecordId: 'rec-1',
      caseId: 'esc-case-1',
      source: 'AUTO',
      durationMs: 3_600_000,
    });

    // Both got posted to the ledger channel (one entry per decision).
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it('does not write a second record when moderation.warn() reports no escalation', async () => {
    const record = baseRecord();
    const { prisma, created } = makeFakePrisma(record);
    const channel = fakeLedgerChannel();
    const { ctx } = createTestContext({
      config: defaultConfig(),
      overrides: { prisma, client: fakeClient(channel) },
    });
    ctx.services.register('moderation', {
      createCase: vi.fn(async () => ({ id: 'case-x', caseNumber: 99 }) as never),
      warn: vi.fn(async () => ({ id: 'warn-case-2', caseNumber: 50 }) as never),
      timeout: vi.fn(async () => ({ id: 'case-x', caseNumber: 99 }) as never),
      getCase: async () => null,
      listCases: async () => ({ items: [], nextCursor: null }),
      openAppeal: async () => ({ appealId: 'appeal-1' }),
      getCaseByNumber: async () => null,
      exportCases: async () => ({ csv: '', count: 0 }),
    } as unknown as ModerationService);
    const service = createEnforcerService(ctx);

    await service.decide({
      guildId: 'g1',
      recordId: 'rec-1',
      decision: 'WARN',
      moderatorId: 'mod-1',
      reason: 'first offense',
      source: 'bot',
    });

    expect(created).toHaveLength(1);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });
});
