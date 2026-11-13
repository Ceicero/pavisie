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
    const remove = vi.fn().mockRejectedValue(Object.assign(new Error('Missing Permissions'), { code: 50013 }));
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
