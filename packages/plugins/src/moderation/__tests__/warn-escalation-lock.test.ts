import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { ModerationServiceImpl } from '../service';
import type { EscalationRule } from '../manifest';

const LADDER: EscalationRule[] = [
  { warnings: 1, action: 'timeout', durationMs: 60_000 },
  { warnings: 2, action: 'kick' },
];

/**
 * Hand-built fake (not the SDK's generic `createPrismaStub`) for the same reason `moderation/__tests__/fakes.ts`'s
 * `createCasePrisma` is: `withNextCaseNumber` calls `prisma.$transaction(cb)` directly, which the proxy stub
 * can't represent. `moderationWarning.count` filters the in-memory rows for real, so it actually reflects
 * whatever `moderationWarning.create` calls have landed by the time it runs — the thing BUG 2's race is about.
 */
function makeFakePrisma() {
  let maxCaseNumber = 0;
  const cases: Record<string, unknown>[] = [];
  const warnings: Record<string, unknown>[] = [];

  const moderationCase = {
    aggregate: async () => ({ _max: { caseNumber: maxCaseNumber } }),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      maxCaseNumber = Math.max(maxCaseNumber, data.caseNumber as number);
      const row = {
        id: `case-${cases.length + 1}`,
        expiredAt: null,
        dmSent: false,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      cases.push(row);
      return row;
    },
    update: async () => undefined,
    updateMany: async () => ({ count: 0 }),
  };

  const moderationWarning = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `warn-${warnings.length + 1}`, active: true, createdAt: new Date(), ...data };
      warnings.push(row);
      return row;
    },
    count: async ({ where }: { where: { guildId: string; userId: string; active: boolean } }) =>
      warnings.filter(
        (w) => w.guildId === where.guildId && w.userId === where.userId && w.active === where.active,
      ).length,
  };

  const prisma = {
    moderationCase,
    moderationWarning,
    $transaction: async (cb: (tx: unknown) => unknown) => cb({ moderationCase }),
  };

  return { prisma: prisma as unknown as PluginContext['prisma'], cases, warnings };
}

/** One member ('member-1') the escalation ladder's timeout/kick actions can act on. */
function fakeClient(): PluginContext['client'] {
  const user = { send: vi.fn(async () => undefined) };
  const member = {
    id: 'member-1',
    user,
    timeout: vi.fn(async () => undefined),
    kick: vi.fn(async () => undefined),
  };
  const guild = {
    id: 'g1',
    name: 'Test Guild',
    members: {
      fetch: async (id: string) => (id === 'member-1' ? member : Promise.reject(new Error('not found'))),
    },
  };
  return {
    guilds: { fetch: async () => guild, cache: new Map() },
    users: { fetch: async () => null },
  } as unknown as PluginContext['client'];
}

describe('ModerationServiceImpl.warn — escalation-ladder race (BUG 2)', () => {
  it('two concurrent warns for the same user each fire their own rung — none skipped', async () => {
    const { prisma, cases } = makeFakePrisma();
    const { ctx } = createTestContext({
      config: { modLogChannelId: null, appealsChannelId: null, dmOnAction: true, escalations: LADDER },
      overrides: { prisma, client: fakeClient() },
    });
    const service = new ModerationServiceImpl(ctx);

    const warnOnce = () =>
      service.warn({
        guildId: 'g1',
        targetId: 'member-1',
        moderatorId: 'mod-1',
        reason: 'test',
        source: 'BOT',
      });

    const [a, b] = await Promise.all([warnOnce(), warnOnce()]);

    // Without the fix, both calls can see the same post-both count (2) and only the kick rung fires — the
    // timeout rung (at count 1) never observed as an exact match. With the fix, both rungs fire exactly once.
    const firedActions = [a.escalation?.rule.action, b.escalation?.rule.action].filter(Boolean).sort();
    expect(firedActions).toEqual(['kick', 'timeout']);

    const escalatedCaseTypes = cases.filter((c) => c.type !== 'WARN').map((c) => c.type).sort();
    expect(escalatedCaseTypes).toEqual(['KICK', 'TIMEOUT']);
  });

  it('releases the lock even when the insert-count-escalate sequence throws', async () => {
    const { prisma } = makeFakePrisma();
    (prisma as unknown as { moderationWarning: { create: () => Promise<never> } }).moderationWarning.create =
      () => Promise.reject(new Error('db exploded'));
    const { ctx, redis } = createTestContext({
      config: { modLogChannelId: null, appealsChannelId: null, dmOnAction: true, escalations: [] },
      overrides: { prisma, client: fakeClient() },
    });
    const service = new ModerationServiceImpl(ctx);

    await expect(
      service.warn({
        guildId: 'g1',
        targetId: 'member-1',
        moderatorId: 'mod-1',
        reason: 'test',
        source: 'BOT',
      }),
    ).rejects.toThrow('db exploded');

    expect(await redis.get('pavisie:moderation:warn-escalation-lock:g1:member-1')).toBeNull();
  });

  it('still records the warning when the lock cannot be acquired (degrades safely, never drops it)', async () => {
    const { prisma, warnings } = makeFakePrisma();
    const { ctx, redis } = createTestContext({
      config: { modLogChannelId: null, appealsChannelId: null, dmOnAction: true, escalations: [] },
      overrides: { prisma, client: fakeClient() },
    });
    const service = new ModerationServiceImpl(ctx);

    // Pre-hold the lock with a TTL longer than the service's retry budget (~1s), so every retry attempt fails
    // and the service is forced down the "degrade — proceed unlocked" path.
    await redis.set('pavisie:moderation:warn-escalation-lock:g1:member-1', 'someone-else', 'PX', 5_000, 'NX');

    await service.warn({
      guildId: 'g1',
      targetId: 'member-1',
      moderatorId: 'mod-1',
      reason: 'test',
      source: 'BOT',
    });

    expect(warnings).toHaveLength(1);
  }, 10_000);
});
