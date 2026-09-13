import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import type { PrismaClient } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import { createEnforcerService, flagRecord, parseAiAssistResponse } from '../service';
import type { AiService } from '../../sdk/services';
import type { EnforcerConfig } from '../manifest';
import type { ModerationService } from '../../sdk/services';

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

/** Guild fake with just enough surface for a DISMISS decision — member lookups fail closed to `null` via `fetchMemberSafe`. */
function fakeClient(): Client<true> {
  const guild = {
    id: 'g1',
    members: {
      fetch: () => Promise.reject(new Error('no member cache in this test fake')),
    },
    channels: {
      fetch: () => Promise.resolve(null),
    },
  };
  return {
    guilds: { fetch: async () => guild },
  } as unknown as Client<true>;
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

/**
 * `decide()` now creates the DECISION record and updates the FLAG record inside one `ctx.prisma.$transaction`
 * (BUG FIX: they used to be two independent sequential writes — a failure between them could leave a flag
 * PENDING forever after the Discord action had already gone through). `enforcerRecord` here backs both the
 * top-level `ctx.prisma.enforcerRecord.*` calls (the initial `findFirst`) AND the `tx.enforcerRecord.*` calls
 * the transaction callback makes — same object, so a decision's `create`/`update` are visible either way.
 */
function makeFakePrisma(record: FakeRecord): PrismaClient {
  let recordNumberSeq = 1000;
  const enforcerRecord = {
    findFirst: () => Promise.resolve({ ...record }),
    aggregate: () => Promise.resolve({ _max: { recordNumber: recordNumberSeq } }),
    create: (args: { data: Record<string, unknown> }) => {
      recordNumberSeq += 1;
      return Promise.resolve({
        id: `decision-${recordNumberSeq}`,
        recordNumber: recordNumberSeq,
        createdAt: new Date(),
        ...args.data,
      });
    },
    update: (args: { data: Partial<FakeRecord> }) => {
      Object.assign(record, args.data);
      return Promise.resolve({ ...record });
    },
  };
  return {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ enforcerRecord }),
    enforcerRecord,
    // Read by the UNMUTE branch (marks the original timed-mute case expired) — not exercised by most tests.
    moderationCase: {
      updateMany: () => Promise.resolve({ count: 0 }),
    },
  } as unknown as PrismaClient;
}

function fakeModeration(): ModerationService {
  return {
    createCase: async () => ({ id: 'case-1', caseNumber: 1 }) as never,
    warn: async () => ({ id: 'case-1', caseNumber: 1 }) as never,
    timeout: async () => ({ id: 'case-1', caseNumber: 1 }) as never,
    getCase: async () => null,
    listCases: async () => ({ items: [], nextCursor: null }),
    openAppeal: async () => ({ appealId: 'appeal-1' }),
    getCaseByNumber: async () => null,
    exportCases: async () => ({ csv: '', count: 0 }),
  };
}

interface FakeMemberSpec {
  highestRolePosition: number;
  isBot?: boolean;
  kick?: (reason?: string) => Promise<void>;
  addRole?: (roleId: string, reason?: string) => Promise<void>;
}

/** Guild fake with real member lookups (for hierarchy-guard and action-propagation tests). */
function fakeClientWithMembers(
  members: Record<string, FakeMemberSpec>,
  opts: { ownerId?: string; ban?: (userId: string, opts: unknown) => Promise<void> } = {},
): Client<true> {
  const botMember = { id: 'bot-1', user: { bot: true }, roles: { highest: { position: 1000 } } };
  const guild = {
    id: 'g1',
    ownerId: opts.ownerId ?? 'owner-1',
    members: {
      me: botMember,
      fetch: (userId: string) => {
        const spec = members[userId];
        if (!spec) return Promise.reject(new Error('member not found'));
        return Promise.resolve({
          id: userId,
          user: { bot: spec.isBot ?? false },
          roles: {
            highest: { position: spec.highestRolePosition },
            add: spec.addRole
              ? (roleId: string, reason?: string) => spec.addRole!(roleId, reason)
              : () => Promise.resolve(undefined),
            remove: () => Promise.resolve(undefined),
          },
          kick: spec.kick ?? (() => Promise.resolve(undefined)),
        });
      },
      ban: opts.ban ?? (() => Promise.resolve(undefined)),
    },
    channels: { fetch: () => Promise.resolve(null) },
  };
  return { guilds: { fetch: async () => guild } } as unknown as Client<true>;
}

function baseRecord(overrides: Partial<FakeRecord> = {}): FakeRecord {
  return {
    id: 'rec-1',
    guildId: 'g1',
    recordNumber: 1,
    status: 'PENDING',
    userId: 'user-1',
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

describe('EnforcerService.decide — locking', () => {
  it('rejects a second concurrent decision while the first holds the lock', async () => {
    const record = baseRecord();
    const prisma = makeFakePrisma(record);
    const { ctx } = createTestContext({
      config: defaultConfig(),
      overrides: { prisma, client: fakeClient() },
    });
    ctx.services.register('moderation', fakeModeration());
    const service = createEnforcerService(ctx);

    const [a, b] = await Promise.allSettled([
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'DISMISS',
        moderatorId: 'mod-1',
        source: 'bot',
      }),
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'DISMISS',
        moderatorId: 'mod-2',
        source: 'bot',
      }),
    ]);

    const results = [a, b];
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already being decided/i);
  });
});

describe('EnforcerService.decide — double-decide rejection', () => {
  it('rejects deciding a flag that has already been decided', async () => {
    const record = baseRecord();
    const prisma = makeFakePrisma(record);
    const { ctx } = createTestContext({
      config: defaultConfig(),
      overrides: { prisma, client: fakeClient() },
    });
    ctx.services.register('moderation', fakeModeration());
    const service = createEnforcerService(ctx);

    const first = await service.decide({
      guildId: 'g1',
      recordId: 'rec-1',
      decision: 'DISMISS',
      moderatorId: 'mod-1',
      source: 'bot',
    });
    expect(first.recordNumber).toBe(1);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'DISMISS',
        moderatorId: 'mod-2',
        source: 'bot',
      }),
    ).rejects.toThrow(/already been decided/i);
  });
});

describe('EnforcerService.decide — allowedDecisions', () => {
  it("rejects a decision that is not in the guild's allowedDecisions list", async () => {
    const record = baseRecord();
    const prisma = makeFakePrisma(record);
    const { ctx } = createTestContext({
      config: defaultConfig({ allowedDecisions: ['dismiss'] }),
      overrides: { prisma, client: fakeClient() },
    });
    ctx.services.register('moderation', fakeModeration());
    const service = createEnforcerService(ctx);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'WARN',
        moderatorId: 'mod-1',
        source: 'bot',
      }),
    ).rejects.toThrow(/disabled on this server/i);
  });

  it('still allows a decision that IS in a restricted allowedDecisions list', async () => {
    const record = baseRecord();
    const prisma = makeFakePrisma(record);
    const { ctx } = createTestContext({
      config: defaultConfig({ allowedDecisions: ['dismiss'] }),
      overrides: { prisma, client: fakeClient() },
    });
    ctx.services.register('moderation', fakeModeration());
    const service = createEnforcerService(ctx);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'DISMISS',
        moderatorId: 'mod-1',
        source: 'bot',
      }),
    ).resolves.toMatchObject({ recordNumber: 1 });
  });

  it('exempts UNMUTE from allowedDecisions entirely — it is not one of the flag-queue decisions', async () => {
    const record = baseRecord();
    const prisma = makeFakePrisma(record);
    const { ctx } = createTestContext({
      config: defaultConfig({ allowedDecisions: ['dismiss'], muteRoleId: 'role-1' }),
      overrides: { prisma, client: fakeClient() },
    });
    ctx.services.register('moderation', fakeModeration());
    const service = createEnforcerService(ctx);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'UNMUTE',
        moderatorId: 'mod-1',
        source: 'bot',
      }),
    ).resolves.toMatchObject({ recordNumber: 1 });
  });
});

describe('EnforcerService.decide — bot-actions envelope normalization', () => {
  it('accepts the {guildId, payload, requestedBy} shape used by apps/bot/src/host/bot-actions.ts', async () => {
    const record = baseRecord();
    const prisma = makeFakePrisma(record);
    const { ctx } = createTestContext({
      config: defaultConfig(),
      overrides: { prisma, client: fakeClient() },
    });
    ctx.services.register('moderation', fakeModeration());
    const service = createEnforcerService(ctx);

    // The public `EnforcerService.decide` type is `EnforcerDecideInput` only — this envelope shape is what
    // `apps/bot/src/host/bot-actions.ts` actually passes at runtime for dashboard-initiated decisions (see
    // `normalizeDecideInput` in ../service.ts), so the cast here mirrors that real call site, not a test hack.
    const result = await service.decide({
      guildId: 'g1',
      payload: { recordId: 'rec-1', decision: 'DISMISS', reason: 'dashboard dismiss' },
      requestedBy: 'dashboard-user-1',
    } as unknown as Parameters<typeof service.decide>[0]);
    expect(result.recordNumber).toBe(1);
  });
});

describe('EnforcerService.decide — hierarchy guard', () => {
  it('fails closed (throws) for WARN when the acting moderator cannot be resolved as a member', async () => {
    const record = baseRecord();
    const prisma = makeFakePrisma(record);
    // fakeClient() rejects every members.fetch call, so both actor and target resolve to null.
    const { ctx } = createTestContext({
      config: defaultConfig(),
      overrides: { prisma, client: fakeClient() },
    });
    ctx.services.register('moderation', fakeModeration());
    const service = createEnforcerService(ctx);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'WARN',
        moderatorId: 'mod-1',
        source: 'bot',
      }),
    ).rejects.toThrow(/could not be verified/i);
  });

  it('blocks TIMEOUT against a higher-ranked target instead of silently allowing it', async () => {
    const record = baseRecord({ userId: 'senior-mod' });
    const prisma = makeFakePrisma(record);
    const client = fakeClientWithMembers({
      'mod-1': { highestRolePosition: 10 },
      'senior-mod': { highestRolePosition: 500 }, // outranks the acting moderator
    });
    const { ctx } = createTestContext({ config: defaultConfig(), overrides: { prisma, client } });
    ctx.services.register('moderation', fakeModeration());
    const service = createEnforcerService(ctx);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'TIMEOUT',
        moderatorId: 'mod-1',
        source: 'bot',
      }),
    ).rejects.toThrow(/at or above/i);
  });

  it('blocks WARN against a higher-ranked target the same way', async () => {
    const record = baseRecord({ userId: 'senior-mod' });
    const prisma = makeFakePrisma(record);
    const client = fakeClientWithMembers({
      'mod-1': { highestRolePosition: 10 },
      'senior-mod': { highestRolePosition: 500 },
    });
    const { ctx } = createTestContext({ config: defaultConfig(), overrides: { prisma, client } });
    ctx.services.register('moderation', fakeModeration());
    const service = createEnforcerService(ctx);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'WARN',
        moderatorId: 'mod-1',
        source: 'bot',
      }),
    ).rejects.toThrow(/at or above/i);
  });

  it('allows TIMEOUT against a lower-ranked target', async () => {
    const record = baseRecord({ userId: 'member-1' });
    const prisma = makeFakePrisma(record);
    const client = fakeClientWithMembers({
      'mod-1': { highestRolePosition: 50 },
      'member-1': { highestRolePosition: 5 },
    });
    const { ctx } = createTestContext({ config: defaultConfig(), overrides: { prisma, client } });
    ctx.services.register('moderation', fakeModeration());
    const service = createEnforcerService(ctx);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'TIMEOUT',
        moderatorId: 'mod-1',
        source: 'bot',
      }),
    ).resolves.toMatchObject({ recordNumber: 1 });
  });
});

describe('EnforcerService.decide — Discord action failures are not swallowed', () => {
  it('propagates a KICK failure instead of recording a phantom case', async () => {
    const record = baseRecord({ userId: 'member-1' });
    const prisma = makeFakePrisma(record);
    const client = fakeClientWithMembers({
      'mod-1': { highestRolePosition: 50 },
      'member-1': { highestRolePosition: 5, kick: () => Promise.reject(new Error('Missing Permissions')) },
    });
    const { ctx } = createTestContext({ config: defaultConfig(), overrides: { prisma, client } });
    const createCase = vi.fn(async () => ({ id: 'case-1', caseNumber: 1 }) as never);
    ctx.services.register('moderation', { ...fakeModeration(), createCase });
    const service = createEnforcerService(ctx);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'KICK',
        moderatorId: 'mod-1',
        reason: 'test reason',
        source: 'bot',
      }),
    ).rejects.toThrow(/Missing Permissions/);
    expect(createCase).not.toHaveBeenCalled();
  });

  it('propagates a MUTE (role add) failure instead of recording a phantom case', async () => {
    const record = baseRecord({ userId: 'member-1' });
    const prisma = makeFakePrisma(record);
    const client = fakeClientWithMembers({
      'mod-1': { highestRolePosition: 50 },
      'member-1': { highestRolePosition: 5, addRole: () => Promise.reject(new Error('Missing Access')) },
    });
    const { ctx } = createTestContext({
      config: defaultConfig({ muteRoleId: 'role-1' }),
      overrides: { prisma, client },
    });
    const createCase = vi.fn(async () => ({ id: 'case-1', caseNumber: 1 }) as never);
    ctx.services.register('moderation', { ...fakeModeration(), createCase });
    const service = createEnforcerService(ctx);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'MUTE',
        moderatorId: 'mod-1',
        source: 'bot',
      }),
    ).rejects.toThrow(/Missing Access/);
    expect(createCase).not.toHaveBeenCalled();
  });

  it('propagates a BAN failure instead of recording a phantom case', async () => {
    const record = baseRecord({ userId: 'member-1' });
    const prisma = makeFakePrisma(record);
    const client = fakeClientWithMembers(
      { 'mod-1': { highestRolePosition: 50 }, 'member-1': { highestRolePosition: 5 } },
      { ban: () => Promise.reject(new Error('Missing Permissions')) },
    );
    const { ctx } = createTestContext({ config: defaultConfig(), overrides: { prisma, client } });
    const createCase = vi.fn(async () => ({ id: 'case-1', caseNumber: 1 }) as never);
    ctx.services.register('moderation', { ...fakeModeration(), createCase });
    const service = createEnforcerService(ctx);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'BAN',
        moderatorId: 'mod-1',
        reason: 'test reason',
        source: 'bot',
      }),
    ).rejects.toThrow(/Missing Permissions/);
    expect(createCase).not.toHaveBeenCalled();
  });
});

describe('EnforcerService.decide — target who has already left the guild', () => {
  /** Only the moderator resolves; `fetchMemberSafe` returns null for the target, exactly as it does for a member who left. */
  function clientWithoutTarget(ban?: (userId: string, opts: unknown) => Promise<void>): Client<true> {
    return fakeClientWithMembers({ 'mod-1': { highestRolePosition: 50 } }, { ban });
  }

  it('refuses KICK instead of writing a case and ledger row for a kick that never happened', async () => {
    const record = baseRecord({ userId: 'departed-1' });
    const prisma = makeFakePrisma(record);
    const { ctx } = createTestContext({
      config: defaultConfig(),
      overrides: { prisma, client: clientWithoutTarget() },
    });
    const createCase = vi.fn(async () => ({ id: 'case-1', caseNumber: 1 }) as never);
    ctx.services.register('moderation', { ...fakeModeration(), createCase });
    const service = createEnforcerService(ctx);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'KICK',
        moderatorId: 'mod-1',
        reason: 'test reason',
        source: 'bot',
      }),
    ).rejects.toThrow(/no longer in this server/i);
    expect(createCase).not.toHaveBeenCalled();
    // The flag is left for someone to decide properly rather than silently marked ACTIONED.
    expect(record.status).toBe('PENDING');
  });

  it('refuses MUTE instead of recording a mute role that was never applied', async () => {
    const record = baseRecord({ userId: 'departed-1' });
    const prisma = makeFakePrisma(record);
    const { ctx } = createTestContext({
      config: defaultConfig({ muteRoleId: 'role-1' }),
      overrides: { prisma, client: clientWithoutTarget() },
    });
    const createCase = vi.fn(async () => ({ id: 'case-1', caseNumber: 1 }) as never);
    ctx.services.register('moderation', { ...fakeModeration(), createCase });
    const service = createEnforcerService(ctx);

    await expect(
      service.decide({
        guildId: 'g1',
        recordId: 'rec-1',
        decision: 'MUTE',
        moderatorId: 'mod-1',
        source: 'bot',
      }),
    ).rejects.toThrow(/no longer in this server/i);
    expect(createCase).not.toHaveBeenCalled();
    expect(record.status).toBe('PENDING');
  });

  it('still allows BAN on a member who has left — a ban works on a user id, so that action really does happen', async () => {
    const record = baseRecord({ userId: 'departed-1' });
    const prisma = makeFakePrisma(record);
    const ban = vi.fn(async () => undefined);
    const { ctx } = createTestContext({
      config: defaultConfig(),
      overrides: { prisma, client: clientWithoutTarget(ban) },
    });
    const createCase = vi.fn(async () => ({ id: 'case-1', caseNumber: 1 }) as never);
    ctx.services.register('moderation', { ...fakeModeration(), createCase });
    const service = createEnforcerService(ctx);

    await service.decide({
      guildId: 'g1',
      recordId: 'rec-1',
      decision: 'BAN',
      moderatorId: 'mod-1',
      reason: 'test reason',
      source: 'bot',
    });

    expect(ban).toHaveBeenCalledTimes(1);
    expect(createCase).toHaveBeenCalledTimes(1);
  });
});

describe('flagRecord — captureContext gates the stored excerpt, not just the context snapshot', () => {
  function fakeClientForFlag(): Client<true> {
    const guild = { id: 'g1', channels: { fetch: () => Promise.resolve(null) } };
    return { guilds: { fetch: async () => guild } } as unknown as Client<true>;
  }

  function fakeFlagPrisma(created: Record<string, unknown>[]): PrismaClient {
    let seq = 0;
    return {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ enforcerRecord: { aggregate: () => Promise.resolve({ _max: { recordNumber: seq } }) } }),
      enforcerRecord: {
        create: (args: { data: Record<string, unknown> }) => {
          seq += 1;
          created.push(args.data);
          return Promise.resolve({ id: `rec-${seq}`, recordNumber: seq, ...args.data });
        },
        update: () => Promise.resolve({}),
      },
    } as unknown as PrismaClient;
  }

  it('stores no excerpt when captureContext is off, even for a manual flag with content', async () => {
    const created: Record<string, unknown>[] = [];
    const { ctx } = createTestContext({
      config: defaultConfig({ captureContext: false }),
      overrides: { prisma: fakeFlagPrisma(created), client: fakeClientForFlag() },
    });

    await flagRecord(ctx, {
      guildId: 'g1',
      userId: 'user-1',
      content: 'this message should not be stored',
      source: 'MANUAL',
    });

    expect(created).toHaveLength(1);
    expect(created[0].excerpt).toBeNull();
  });

  it('stores an excerpt when captureContext is on', async () => {
    const created: Record<string, unknown>[] = [];
    const { ctx } = createTestContext({
      config: defaultConfig({ captureContext: true }),
      overrides: { prisma: fakeFlagPrisma(created), client: fakeClientForFlag() },
    });

    await flagRecord(ctx, { guildId: 'g1', userId: 'user-1', content: 'hello world', source: 'MANUAL' });

    expect(created[0].excerpt).toBe('hello world');
  });

  it('does nothing (no service call, no stored score) when aiAssist is off, even with an ai service registered', async () => {
    const created: Record<string, unknown>[] = [];
    const { ctx } = createTestContext({
      config: defaultConfig({ aiAssist: false }),
      overrides: { prisma: fakeFlagPrisma(created), client: fakeClientForFlag() },
    });
    const complete = vi.fn();
    ctx.services.register('ai', { complete, test: async () => ({ ok: true }) } as AiService);

    await flagRecord(ctx, { guildId: 'g1', userId: 'user-1', content: 'hello world', source: 'MANUAL' });

    expect(complete).not.toHaveBeenCalled();
    expect(created[0].riskScore).toBeNull();
  });

  it('calls the ai service and stores the parsed risk score/explanation when aiAssist is on', async () => {
    const created: Record<string, unknown>[] = [];
    const { ctx } = createTestContext({
      config: defaultConfig({ aiAssist: true }),
      overrides: { prisma: fakeFlagPrisma(created), client: fakeClientForFlag() },
    });
    const complete = vi.fn(async () => ({
      text: 'Risk: 72\nExplanation: Looks like targeted harassment.',
      promptTokens: 10,
      completionTokens: 10,
      model: 'x',
      provider: 'x',
    }));
    ctx.services.register('ai', { complete, test: async () => ({ ok: true }) } as AiService);

    await flagRecord(ctx, {
      guildId: 'g1',
      userId: 'user-1',
      content: 'hello world',
      policyName: 'Harassment',
      source: 'MANUAL',
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(created[0].riskScore).toBe(72);
    expect(created[0].aiExplanation).toBe('Looks like targeted harassment.');
  });

  it('flags successfully with no risk score when the ai service throws (never blocks the flag)', async () => {
    const created: Record<string, unknown>[] = [];
    const { ctx } = createTestContext({
      config: defaultConfig({ aiAssist: true }),
      overrides: { prisma: fakeFlagPrisma(created), client: fakeClientForFlag() },
    });
    ctx.services.register('ai', {
      complete: vi.fn(async () => {
        throw new Error('budget exceeded');
      }),
      test: async () => ({ ok: true }),
    } as AiService);

    await expect(
      flagRecord(ctx, { guildId: 'g1', userId: 'user-1', content: 'hello world', source: 'MANUAL' }),
    ).resolves.toMatchObject({ recordNumber: 1 });

    expect(created[0].riskScore).toBeNull();
  });

  it('does not overwrite an explicitly-supplied riskScore (e.g. an AI_ASSIST-sourced flag) by calling the ai service again', async () => {
    const created: Record<string, unknown>[] = [];
    const { ctx } = createTestContext({
      config: defaultConfig({ aiAssist: true }),
      overrides: { prisma: fakeFlagPrisma(created), client: fakeClientForFlag() },
    });
    const complete = vi.fn();
    ctx.services.register('ai', { complete, test: async () => ({ ok: true }) } as AiService);

    await flagRecord(ctx, {
      guildId: 'g1',
      userId: 'user-1',
      content: 'hello world',
      riskScore: 40,
      aiExplanation: 'pre-computed',
      source: 'AI_ASSIST',
    });

    expect(complete).not.toHaveBeenCalled();
    expect(created[0].riskScore).toBe(40);
  });
});

describe('parseAiAssistResponse', () => {
  it('parses a well-formed two-line response', () => {
    expect(parseAiAssistResponse('Risk: 55\nExplanation: Mild profanity.')).toEqual({
      riskScore: 55,
      explanation: 'Mild profanity.',
    });
  });

  it('clamps an out-of-range score into 0-100', () => {
    expect(parseAiAssistResponse('Risk: 500\nExplanation: x')?.riskScore).toBe(100);
  });

  it('returns null for a response with no parseable Risk: line', () => {
    expect(parseAiAssistResponse('I refuse to answer that.')).toBeNull();
  });
});
