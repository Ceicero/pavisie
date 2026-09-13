import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { PrismaClient } from '@pavisie/database';
import {
  collectGuildExport,
  processDelete,
  processExport,
  redactSecrets,
  type DataRequestJobData,
  type DataRequestsWorkerDeps,
} from '../data-requests';

function fakeJob(data: DataRequestJobData): Job<DataRequestJobData> {
  return { data } as unknown as Job<DataRequestJobData>;
}

describe('redactSecrets', () => {
  it('replaces secret-shaped keys with a placeholder, recursively, without touching other fields', () => {
    const input = {
      id: 'g1',
      apiKeyEnc: 'v1:abc123',
      nested: { secretEnc: 'v1:def456', accessToken: 'tok', ok: 'keep-me' },
      list: [{ refreshToken: 'r1', name: 'keep' }],
    };
    const result = redactSecrets(input) as typeof input;
    expect(result.apiKeyEnc).toBe('[redacted]');
    expect(result.nested.secretEnc).toBe('[redacted]');
    expect(result.nested.accessToken).toBe('[redacted]');
    expect(result.nested.ok).toBe('keep-me');
    expect((result.list[0] as Record<string, unknown>).refreshToken).toBe('[redacted]');
    expect((result.list[0] as Record<string, unknown>).name).toBe('keep');
    expect(result.id).toBe('g1');
  });
});

function fakePrismaForExport(overrides: Record<string, unknown> = {}): PrismaClient {
  const empty = { findMany: async () => [], findUnique: async () => null };
  return {
    guild: { findUnique: async () => ({ id: 'g1', name: 'Test Guild' }) },
    guildConfig: { findUnique: async () => ({ guildId: 'g1' }) },
    pluginConfig: empty,
    pluginState: empty,
    moderationCase: empty,
    moderationWarning: empty,
    moderationNote: empty,
    moderationAppeal: empty,
    automodRule: empty,
    automodEvent: empty,
    ticket: empty,
    rolePanel: empty,
    levelProfile: empty,
    enforcerPolicy: empty,
    enforcerRecord: empty,
    auditLog: empty,
    birthday: empty,
    gameAccountLink: empty,
    gameStatSnapshot: empty,
    dataRequest: { update: vi.fn(async () => ({})) },
    dataExportBlob: { upsert: vi.fn(async () => ({})) },
    ...overrides,
  } as unknown as PrismaClient;
}

describe('collectGuildExport', () => {
  it('never leaks a plugin config secret field in the exported JSON', async () => {
    const prisma = fakePrismaForExport({
      pluginConfig: {
        findMany: async () => [{ pluginId: 'ai', config: { apiKeyEnc: 'v1:super-secret', model: 'gpt-4o' } }],
      },
    });

    const data = await collectGuildExport(prisma, 'g1');
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).toContain('gpt-4o');
  });

  it('includes member-shared birthdays as month/day only', async () => {
    const prisma = fakePrismaForExport({
      birthday: { findMany: async () => [{ userId: 'u1', month: 3, day: 4 }] },
    });

    const data = await collectGuildExport(prisma, 'g1');
    expect(data.birthdays).toEqual([{ userId: 'u1', month: 3, day: 4 }]);
    expect(JSON.stringify(data.birthdays)).not.toContain('year');
  });

  it('includes linked game accounts and stat snapshots (gamestats plugin)', async () => {
    const prisma = fakePrismaForExport({
      gameAccountLink: {
        findMany: async () => [
          { userId: 'u1', provider: 'STEAM', externalId: '76561198000000000', externalName: 'Player' },
        ],
      },
      gameStatSnapshot: {
        findMany: async () => [
          { userId: 'u1', game: 'dbd', stats: { escapes: 3 }, fetchedAt: new Date(0), lastError: null },
        ],
      },
    });

    const data = await collectGuildExport(prisma, 'g1');
    expect(data.gamestats).toMatchObject({
      accountLinks: [{ userId: 'u1', provider: 'STEAM', externalId: '76561198000000000' }],
      statSnapshots: [{ userId: 'u1', game: 'dbd', stats: { escapes: 3 } }],
    });
  });
});

describe('processExport', () => {
  it('marks the request RUNNING, stores the blob, and marks it DONE with a resultUrl', async () => {
    const updateCalls: unknown[] = [];
    const upsertCalls: unknown[] = [];
    const prisma = fakePrismaForExport({
      dataRequest: { update: vi.fn(async (args: unknown) => updateCalls.push(args)) },
      dataExportBlob: { upsert: vi.fn(async (args: unknown) => upsertCalls.push(args)) },
    });

    await processExport(prisma, fakeJob({ requestId: 'req-1', guildId: 'g1', requestedBy: 'user-1' }));

    expect((updateCalls[0] as any).data.status).toBe('RUNNING');
    expect((upsertCalls[0] as any).create.requestId).toBe('req-1');
    const finalUpdate = updateCalls[updateCalls.length - 1] as any;
    expect(finalUpdate.data.status).toBe('DONE');
    expect(finalUpdate.data.resultUrl).toContain('req-1');
    expect(finalUpdate.data.completedAt).toBeInstanceOf(Date);
  });
});

describe('processDelete', () => {
  function harness() {
    const before = { id: 'g1', name: 'Test Guild', iconHash: null, ownerId: 'owner-1', memberCount: 5 };
    const guildDeleteCalls: unknown[] = [];
    const dataRequestCreateCalls: unknown[] = [];
    const updateCalls: unknown[] = [];

    const prisma = {
      guild: {
        findUnique: vi.fn(async () => before),
        delete: vi.fn(async (args: unknown) => guildDeleteCalls.push(args)),
        upsert: vi.fn(async () => ({ id: 'g1' })),
        update: vi.fn(async () => ({ id: 'g1' })),
      },
      guildConfig: { upsert: vi.fn(async () => ({})) },
      dataRetentionPolicy: { upsert: vi.fn(async () => ({})) },
      dataRequest: {
        update: vi.fn(async (args: unknown) => updateCalls.push(args)),
        create: vi.fn(async (args: unknown) => {
          dataRequestCreateCalls.push(args);
          return { id: 'req-2' };
        }),
      },
    } as unknown as PrismaClient;

    return { prisma, before, guildDeleteCalls, dataRequestCreateCalls, updateCalls };
  }

  it('deletes the guild (cascading everything), re-creates a minimal shell, and records a new completed request', async () => {
    const { prisma, guildDeleteCalls, dataRequestCreateCalls, updateCalls } = harness();
    const client = { guilds: { fetch: vi.fn(async () => ({ id: 'g1' })) } } as any;
    const deps: DataRequestsWorkerDeps = {
      prisma,
      client,
      connection: {} as any,
      logger: { error: vi.fn() } as any,
    };

    await processDelete(deps, fakeJob({ requestId: 'req-1', guildId: 'g1', requestedBy: 'user-1' }));

    expect(guildDeleteCalls).toHaveLength(1);
    expect((updateCalls[0] as any).data.status).toBe('RUNNING');
    expect(dataRequestCreateCalls).toHaveLength(1);
    expect((dataRequestCreateCalls[0] as any).data).toMatchObject({
      guildId: 'g1',
      type: 'DELETE',
      status: 'DONE',
      requestedBy: 'user-1',
    });
  });

  it('marks the request FAILED (does not delete) when the guild is already gone', async () => {
    const { prisma, guildDeleteCalls, updateCalls } = harness();
    (prisma.guild.findUnique as any) = vi.fn(async () => null);
    const client = { guilds: { fetch: vi.fn(async () => null) } } as any;
    const deps: DataRequestsWorkerDeps = {
      prisma,
      client,
      connection: {} as any,
      logger: { error: vi.fn() } as any,
    };

    await processDelete(
      deps,
      fakeJob({ requestId: 'req-1', guildId: 'missing-guild', requestedBy: 'user-1' }),
    );

    expect(guildDeleteCalls).toHaveLength(0);
    expect((updateCalls[0] as any).data.status).toBe('FAILED');
  });
});
