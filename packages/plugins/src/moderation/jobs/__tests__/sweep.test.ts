import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { createTestContext } from '../../../sdk/testing';
import { sweepJob } from '../sweep';

const GUILD_ID = '111111111111111111';
const ROLE_ID = '333333333333333333';

function muteCase(id: string, targetId: string) {
  return {
    id,
    guildId: GUILD_ID,
    targetId,
    caseNumber: 7,
    type: 'ROLE_ADD',
    metadata: { enforcerMute: true, roleId: ROLE_ID },
    expiredAt: null,
    deletedAt: null,
  };
}

const job = { data: {} } as unknown as Job<Record<string, never>>;

/**
 * `members` maps a target id to what `guild.members.fetch` does for it: an Error is thrown, anything else
 * is the `roles.remove` mock of a member who currently has the mute role.
 */
function build(rows: unknown[], members: Record<string, Error | ReturnType<typeof vi.fn>>) {
  const expiredIds: string[] = [];
  const { ctx } = createTestContext({
    prismaOverrides: {
      moderationCase: {
        findMany: async () => rows,
        update: async (args: any) => {
          expiredIds.push(args.where.id);
          return {};
        },
      },
    },
    overrides: {
      client: {
        user: { id: 'bot' },
        guilds: {
          fetch: async () => ({
            members: {
              fetch: async ({ user }: { user: string }) => {
                const entry = members[user];
                if (entry instanceof Error) throw entry;
                return { roles: { cache: new Map([[ROLE_ID, true]]), remove: entry } };
              },
            },
          }),
        },
      } as any,
    },
  });
  return { ctx, expiredIds };
}

describe('sweepJob — overdue enforcer timed MUTE (ROLE_ADD)', () => {
  it('removes the mute role and marks the case expired', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const { ctx, expiredIds } = build([muteCase('case-1', 'user-1')], { 'user-1': remove });

    await sweepJob.processor(ctx, job);

    expect(remove).toHaveBeenCalledWith(ROLE_ID, expect.stringContaining('caught by sweep'));
    expect(expiredIds).toEqual(['case-1']);
  });

  it('leaves the case active when the role removal fails, so the next sweep retries', async () => {
    const remove = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Missing Permissions'), { code: 50013 }));
    const { ctx, expiredIds } = build([muteCase('case-1', 'user-1')], { 'user-1': remove });

    await expect(sweepJob.processor(ctx, job)).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(expiredIds).toEqual([]);
  });

  it('leaves the case active when the member lookup fails during an outage', async () => {
    const { ctx, expiredIds } = build([muteCase('case-1', 'user-1')], {
      'user-1': Object.assign(new Error('Service Unavailable'), { status: 503 }),
    });

    await sweepJob.processor(ctx, job);

    expect(expiredIds).toEqual([]);
  });

  it('marks the case expired when the member left (10007) or the role was deleted (10011)', async () => {
    const remove = vi.fn().mockRejectedValue(Object.assign(new Error('Unknown Role'), { code: 10011 }));
    const { ctx, expiredIds } = build([muteCase('case-1', 'user-1'), muteCase('case-2', 'user-2')], {
      'user-1': Object.assign(new Error('Unknown Member'), { code: 10007 }),
      'user-2': remove,
    });

    await sweepJob.processor(ctx, job);

    expect(expiredIds).toEqual(['case-1', 'case-2']);
  });

  it('keeps processing later cases after one fails', async () => {
    const failing = vi.fn().mockRejectedValue(Object.assign(new Error('outage'), { status: 500 }));
    const working = vi.fn().mockResolvedValue(undefined);
    const { ctx, expiredIds } = build([muteCase('case-1', 'user-1'), muteCase('case-2', 'user-2')], {
      'user-1': failing,
      'user-2': working,
    });

    await sweepJob.processor(ctx, job);

    expect(working).toHaveBeenCalledTimes(1);
    expect(expiredIds).toEqual(['case-2']);
  });
});

function banCase(id: string, targetId: string, expiresAt = new Date(Date.now() - 1000)) {
  return { ...muteCase(id, targetId), type: 'BAN', metadata: null, expiresAt };
}

describe('sweepJob — overdue BAN', () => {
  function buildBans(
    rows: unknown[],
    opts: {
      removeBan?: () => Promise<unknown>;
      superseded?: boolean;
      findMany?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const expiredIds: string[] = [];
    const removeBan = vi.fn(opts.removeBan ?? (async () => undefined));
    const findMany = opts.findMany ?? vi.fn(async () => rows);
    const { ctx } = createTestContext({
      prismaOverrides: {
        moderationCase: {
          findMany,
          findFirst: async () => (opts.superseded ? { id: 'newer' } : null),
          update: async (args: any) => {
            expiredIds.push(args.where.id);
            return {};
          },
          updateMany: async () => ({ count: 1 }),
          create: async () => ({ id: 'unban-1' }),
        },
      },
      overrides: {
        client: {
          user: { id: 'bot' },
          guilds: { fetch: async () => ({ id: GUILD_ID, bans: { remove: removeBan } }) },
        } as any,
      },
    });
    return { ctx, expiredIds, removeBan, findMany };
  }

  it('marks the case expired when the ban is already gone (Unknown Ban, 10026)', async () => {
    const { ctx, expiredIds } = buildBans([banCase('case-1', 'user-1')], {
      removeBan: () => Promise.reject(Object.assign(new Error('Unknown Ban'), { code: 10026 })),
    });
    await sweepJob.processor(ctx, job);
    expect(expiredIds).toEqual(['case-1']);
  });

  it('does not unban when a newer ban supersedes it, and marks only this case expired', async () => {
    const { ctx, expiredIds, removeBan } = buildBans([banCase('case-1', 'user-1')], { superseded: true });
    await sweepJob.processor(ctx, job);
    expect(removeBan).not.toHaveBeenCalled();
    expect(expiredIds).toEqual(['case-1']);
  });

  it('leaves the case active when Discord fails with a server error', async () => {
    const { ctx, expiredIds } = buildBans([banCase('case-1', 'user-1')], {
      removeBan: () => Promise.reject(Object.assign(new Error('503'), { status: 503 })),
    });
    await expect(sweepJob.processor(ctx, job)).resolves.toBeUndefined();
    expect(expiredIds).toEqual([]);
  });

  it('orders by expiresAt then id', async () => {
    const { ctx, findMany } = buildBans([]);
    await sweepJob.processor(ctx, job);
    expect(findMany.mock.calls[0]?.[0].orderBy).toEqual([{ expiresAt: 'asc' }, { id: 'asc' }]);
    expect(findMany.mock.calls[0]?.[0].where.OR).toBeUndefined();
  });

  it('pages past the last row seen: a full page then a short page are both processed', async () => {
    const full = Array.from({ length: 100 }, (_, i) => banCase(`a-${i}`, `u-${i}`));
    const short = [banCase('b-0', 'u-b')];
    const findMany = vi.fn().mockResolvedValueOnce(full).mockResolvedValueOnce(short);
    const { ctx, expiredIds, findMany: fm } = buildBans([], { superseded: true, findMany });
    await sweepJob.processor(ctx, job);
    expect(fm).toHaveBeenCalledTimes(2);
    const last = full[99]!;
    expect(fm.mock.calls[1]?.[0]).toMatchObject({
      take: 100,
      where: {
        OR: [{ expiresAt: { gt: last.expiresAt } }, { expiresAt: last.expiresAt, id: { gt: 'a-99' } }],
      },
    });
    expect(expiredIds).toHaveLength(101);
    expect(expiredIds).toContain('b-0');
  });

  it('stops after the page cap even when every page is full', async () => {
    const findMany = vi.fn(async () => Array.from({ length: 100 }, (_, i) => banCase(`a-${i}`, `u-${i}`)));
    const { ctx, findMany: fm } = buildBans([], { superseded: true, findMany });
    await sweepJob.processor(ctx, job);
    expect(fm).toHaveBeenCalledTimes(10);
  });
});
