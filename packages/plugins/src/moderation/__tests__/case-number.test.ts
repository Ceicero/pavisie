import { describe, expect, it } from 'vitest';
import { Prisma } from '@pavisie/database';
import type { PluginContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { ModerationServiceImpl } from '../service';

/**
 * `withNextCaseNumber`/`nextCaseNumber` (@pavisie/database) call `prisma.$transaction(cb)` directly — a
 * top-level method the SDK's generic `createPrismaStub` proxy can't represent (it only proxies
 * `prisma.<model>.<method>()` calls). This hand-built fake implements just enough of the `PrismaClient` surface
 * `ModerationServiceImpl.createCase` touches to exercise the real retry loop.
 */
function buildFakePrisma(opts: { failures: number; onCreateAttempt?: () => void }) {
  let maxCaseNumber = 0;
  let createAttempts = 0;

  const moderationCase = {
    aggregate: async () => ({ _max: { caseNumber: maxCaseNumber } }),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      createAttempts += 1;
      opts.onCreateAttempt?.();
      if (createAttempts <= opts.failures) {
        // Simulate a concurrent insert winning the race for this case number before this attempt commits.
        maxCaseNumber = Math.max(maxCaseNumber, data.caseNumber as number);
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the fields: (`guildId`,`caseNumber`)',
          {
            code: 'P2002',
            clientVersion: 'test',
          },
        );
      }
      maxCaseNumber = Math.max(maxCaseNumber, data.caseNumber as number);
      return {
        id: 'case-1',
        guildId: data.guildId,
        caseNumber: data.caseNumber,
        type: data.type,
        targetId: data.targetId,
        moderatorId: data.moderatorId,
        reason: data.reason ?? null,
        evidenceUrls: data.evidenceUrls ?? [],
        durationMs: data.durationMs ?? null,
        expiresAt: data.expiresAt ?? null,
        expiredAt: null,
        dmSent: false,
        metadata: data.metadata ?? {},
        source: data.source,
        automodRuleId: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    update: async () => undefined,
  };

  const prisma = {
    moderationCase,
    $transaction: async (cb: (tx: unknown) => unknown) => cb({ moderationCase }),
  };

  return { prisma: prisma as unknown as PluginContext['prisma'], attempts: () => createAttempts };
}

describe('createCase — case number allocation retries on collision', () => {
  it('retries through withNextCaseNumber and succeeds once a free number is found', async () => {
    const { prisma, attempts } = buildFakePrisma({ failures: 2 });
    const { ctx } = createTestContext({ config: {}, overrides: { prisma } });

    const service = new ModerationServiceImpl(ctx);
    const row = await service.createCase({
      guildId: 'g1',
      type: 'NOTE',
      targetId: 'u1',
      moderatorId: 'm1',
      source: 'BOT',
      dmUser: false,
    });

    expect(row.id).toBe('case-1');
    expect(attempts()).toBe(3); // 2 collisions + 1 success
  });

  it('gives up after exhausting retries (3 attempts) and lets the error propagate', async () => {
    const { prisma } = buildFakePrisma({ failures: 10 });
    const { ctx } = createTestContext({ config: {}, overrides: { prisma } });

    const service = new ModerationServiceImpl(ctx);
    await expect(
      service.createCase({
        guildId: 'g1',
        type: 'NOTE',
        targetId: 'u1',
        moderatorId: 'm1',
        source: 'BOT',
        dmUser: false,
      }),
    ).rejects.toThrow();
  });
});
