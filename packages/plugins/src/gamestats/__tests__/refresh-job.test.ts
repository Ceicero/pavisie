import { afterEach, describe, expect, it, vi } from 'vitest';
import { env as coreEnv } from '@pavisie/core';
import type { GameAccountLink } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';

// `jobs/refresh.ts` imports `refreshMemberStats` from `../service` — mock it so this file tests only the job's
// own iteration/gating/isolation logic, not the Steam client or Prisma writes (those are covered by
// `service.test.ts` and `steam.test.ts`). See `twitch-chat-manager.test.ts` for the same hoisted-mock pattern.
const mocks = vi.hoisted(() => ({
  refreshMemberStats: vi.fn(),
}));
vi.mock('../service', () => mocks);

import { gamestatsRefreshJob } from '../jobs/refresh';

function makeLink(overrides: Partial<GameAccountLink> = {}): GameAccountLink {
  return {
    id: 'link-1',
    guildId: 'guild-1',
    userId: 'user-1',
    provider: 'STEAM',
    externalId: '765',
    externalName: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as GameAccountLink;
}

describe('gamestatsRefreshJob', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is registered with the spec\'s cron pattern and concurrency', () => {
    expect(gamestatsRefreshJob.name).toBe('gamestats-refresh');
    expect(gamestatsRefreshJob.repeat).toEqual({ pattern: '*/30 * * * *' });
    expect(gamestatsRefreshJob.concurrency).toBe(1);
  });

  it('no-ops cleanly without STEAM_API_KEY — never even queries for links', async () => {
    const findManySpy = vi.fn();
    const { ctx } = createTestContext({
      overrides: { env: { ...coreEnv, STEAM_API_KEY: undefined } },
      prismaOverrides: { gameAccountLink: { findMany: findManySpy } },
    });

    await gamestatsRefreshJob.processor(ctx, {} as never);

    expect(findManySpy).not.toHaveBeenCalled();
    expect(mocks.refreshMemberStats).not.toHaveBeenCalled();
  });

  it('refreshes every currently-supported game for a link in an enabled guild, and skips a disabled guild entirely', async () => {
    mocks.refreshMemberStats.mockResolvedValue({ ok: true });
    const links = [
      makeLink({ id: 'l1', guildId: 'guild-enabled', userId: 'u1' }),
      makeLink({ id: 'l2', guildId: 'guild-disabled', userId: 'u2' }),
    ];
    const { ctx } = createTestContext({
      overrides: { env: { ...coreEnv, STEAM_API_KEY: 'test-key' } },
      prismaOverrides: { gameAccountLink: { findMany: async () => links } },
    });
    ctx.isEnabled = async (guildId: string) => guildId === 'guild-enabled';

    await gamestatsRefreshJob.processor(ctx, {} as never);

    // Exactly one currently-registered game (dbd) × one enabled link.
    expect(mocks.refreshMemberStats).toHaveBeenCalledTimes(1);
    const [, refreshedLink, refreshedGame] = mocks.refreshMemberStats.mock.calls[0]!;
    expect(refreshedLink).toMatchObject({ id: 'l1', guildId: 'guild-enabled' });
    expect(refreshedGame).toMatchObject({ key: 'dbd' });
  }, 10_000);

  it('isolates a per-row failure: one link throwing does not stop the rest', async () => {
    mocks.refreshMemberStats.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ ok: true });
    const links = [makeLink({ id: 'l1', guildId: 'g1' }), makeLink({ id: 'l2', guildId: 'g2' })];
    const { ctx } = createTestContext({
      overrides: { env: { ...coreEnv, STEAM_API_KEY: 'test-key' } },
      prismaOverrides: { gameAccountLink: { findMany: async () => links } },
    });

    await expect(gamestatsRefreshJob.processor(ctx, {} as never)).resolves.toBeUndefined();

    expect(mocks.refreshMemberStats).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('treats an isEnabled rejection as "not enabled" rather than aborting the whole run', async () => {
    mocks.refreshMemberStats.mockResolvedValue({ ok: true });
    const links = [makeLink({ id: 'l1', guildId: 'g1' }), makeLink({ id: 'l2', guildId: 'g2' })];
    const { ctx } = createTestContext({
      overrides: { env: { ...coreEnv, STEAM_API_KEY: 'test-key' } },
      prismaOverrides: { gameAccountLink: { findMany: async () => links } },
    });
    ctx.isEnabled = async (guildId: string) => {
      if (guildId === 'g1') throw new Error('config store unavailable');
      return true;
    };

    await expect(gamestatsRefreshJob.processor(ctx, {} as never)).resolves.toBeUndefined();

    expect(mocks.refreshMemberStats).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('does nothing when there are no linked accounts at all', async () => {
    const { ctx } = createTestContext({
      overrides: { env: { ...coreEnv, STEAM_API_KEY: 'test-key' } },
      prismaOverrides: { gameAccountLink: { findMany: async () => [] } },
    });

    await gamestatsRefreshJob.processor(ctx, {} as never);

    expect(mocks.refreshMemberStats).not.toHaveBeenCalled();
  });
});
