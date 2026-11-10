import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { createTestContext } from '../../../sdk/testing';
import { expireJob } from '../expire';

const GUILD_ID = '111111111111111111';
const TARGET_ID = '222222222222222222';
const ROLE_ID = '333333333333333333';
const CASE_ID = 'case-1';

/** Enforcer's timed MUTE creates a `ROLE_ADD` moderation case with `metadata: { enforcerMute: true, roleId }`. */
function enforcerMuteCase(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_ID,
    guildId: GUILD_ID,
    targetId: TARGET_ID,
    caseNumber: 7,
    type: 'ROLE_ADD',
    metadata: { enforcerMute: true, roleId: ROLE_ID },
    expiredAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function fakeJob(caseId: string): Job<{ caseId: string }> {
  return { data: { caseId } } as unknown as Job<{ caseId: string }>;
}

describe('expireJob — enforcer timed MUTE (ROLE_ADD) expiry', () => {
  it('removes the mute role from the member and marks the case expired', async () => {
    const updateCalls: unknown[] = [];
    const removeRole = vi.fn().mockResolvedValue(undefined);

    const { ctx } = createTestContext({
      prismaOverrides: {
        moderationCase: {
          findUnique: async () => enforcerMuteCase(),
          update: async (args: any) => {
            updateCalls.push(args);
            return { ...enforcerMuteCase(), ...args.data };
          },
        },
      },
      overrides: {
        client: {
          guilds: {
            fetch: async () => ({
              members: {
                fetch: async () => ({
                  roles: { cache: new Map([[ROLE_ID, true]]), remove: removeRole },
                }),
              },
            }),
          },
        } as any,
      },
    });

    await expireJob.processor(ctx, fakeJob(CASE_ID));

    expect(removeRole).toHaveBeenCalledWith(ROLE_ID, expect.stringContaining('Mute expired'));
    expect(updateCalls).toHaveLength(1);
    expect((updateCalls[0] as any).data.expiredAt).toBeInstanceOf(Date);
  });

  it('fetches the member fresh instead of trusting the member cache, and expires the case when the role is already gone', async () => {
    const updateCalls: unknown[] = [];
    const removeRole = vi.fn();
    const fetchMember = vi.fn().mockResolvedValue({ roles: { cache: new Map(), remove: removeRole } });

    const { ctx } = createTestContext({
      prismaOverrides: {
        moderationCase: {
          findUnique: async () => enforcerMuteCase(),
          update: async (args: any) => {
            updateCalls.push(args);
            return {};
          },
        },
      },
      overrides: {
        client: { guilds: { fetch: async () => ({ members: { fetch: fetchMember } }) } } as any,
      },
    });

    await expireJob.processor(ctx, fakeJob(CASE_ID));

    expect(fetchMember).toHaveBeenCalledWith({ user: TARGET_ID, force: true });
    expect(removeRole).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
  });

  it('does not touch roles for a ROLE_ADD case that is not an enforcer mute, but still marks it expired', async () => {
    const updateCalls: unknown[] = [];
    const removeRole = vi.fn();

    const { ctx } = createTestContext({
      prismaOverrides: {
        moderationCase: {
          findUnique: async () => enforcerMuteCase({ metadata: { someOtherThing: true } }),
          update: async (args: any) => {
            updateCalls.push(args);
            return {};
          },
        },
      },
      overrides: {
        client: {
          guilds: {
            fetch: async () => ({
              members: { fetch: async () => ({ roles: { cache: new Map(), remove: removeRole } }) as any },
            }),
          },
        } as any,
      },
    });

    await expireJob.processor(ctx, fakeJob(CASE_ID));

    expect(removeRole).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
  });

  it('is a no-op when the case is already expired', async () => {
    const update = vi.fn();
    const { ctx } = createTestContext({
      prismaOverrides: {
        moderationCase: {
          findUnique: async () => enforcerMuteCase({ expiredAt: new Date() }),
          update,
        },
      },
    });

    await expireJob.processor(ctx, fakeJob(CASE_ID));

    expect(update).not.toHaveBeenCalled();
  });
});

describe('expireJob — temporary BAN expiry', () => {
  function banCase() {
    return enforcerMuteCase({ type: 'BAN', metadata: null });
  }
  function build(removeBan: () => Promise<unknown>) {
    const update = vi.fn().mockResolvedValue({});
    const { ctx } = createTestContext({
      prismaOverrides: {
        moderationCase: {
          findUnique: async () => banCase(),
          update,
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
    return { ctx, update };
  }

  it('leaves the case active and rethrows when Discord fails to lift the ban', async () => {
    const { ctx, update } = build(() => Promise.reject(Object.assign(new Error('503'), { status: 503 })));
    await expect(expireJob.processor(ctx, fakeJob(CASE_ID))).rejects.toThrow('503');
    expect(update).not.toHaveBeenCalled();
  });

  it('marks the case expired when the ban was already lifted by hand (Unknown Ban)', async () => {
    const { ctx, update } = build(() =>
      Promise.reject(Object.assign(new Error('Unknown Ban'), { code: 10026 })),
    );
    await expireJob.processor(ctx, fakeJob(CASE_ID));
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('expireJob — enforcer mute removal failures', () => {
  function build(removeRole: ReturnType<typeof vi.fn>) {
    const updateCalls: unknown[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        moderationCase: {
          findUnique: async () => enforcerMuteCase(),
          update: async (args: any) => {
            updateCalls.push(args);
            return {};
          },
        },
      },
      overrides: {
        client: {
          guilds: {
            fetch: async () => ({
              members: {
                fetch: async () => ({ roles: { cache: new Map([[ROLE_ID, true]]), remove: removeRole } }),
              },
            }),
          },
        } as any,
      },
    });
    return { ctx, updateCalls };
  }

  it('keeps the case active and rethrows so the job retries when role removal fails', async () => {
    const { ctx, updateCalls } = build(vi.fn().mockRejectedValue(Object.assign(new Error('outage'), { code: 500 })));
    await expect(expireJob.processor(ctx, fakeJob(CASE_ID))).rejects.toThrow('outage');
    expect(updateCalls).toHaveLength(0);
  });

  it('treats an already-deleted mute role (10011) as lifted and marks the case expired', async () => {
    const { ctx, updateCalls } = build(vi.fn().mockRejectedValue(Object.assign(new Error('Unknown Role'), { code: 10011 })));
    await expireJob.processor(ctx, fakeJob(CASE_ID));
    expect(updateCalls).toHaveLength(1);
  });

  /** Builds a context whose guild or member lookup fails before any role can be removed. */
  function buildLookupFailure(fail: { guild?: unknown; member?: unknown }) {
    const updateCalls: unknown[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        moderationCase: {
          findUnique: async () => enforcerMuteCase(),
          update: async (args: any) => {
            updateCalls.push(args);
            return {};
          },
        },
      },
      overrides: {
        client: {
          guilds: {
            fetch: async () => {
              if (fail.guild) throw fail.guild;
              return {
                members: {
                  fetch: async () => {
                    throw fail.member;
                  },
                },
              };
            },
          },
        } as any,
      },
    });
    return { ctx, updateCalls };
  }

  it('keeps the case active and rethrows when the member lookup fails for a reason other than Unknown Member', async () => {
    const { ctx, updateCalls } = buildLookupFailure({
      member: Object.assign(new Error('Service Unavailable'), { status: 503 }),
    });
    await expect(expireJob.processor(ctx, fakeJob(CASE_ID))).rejects.toThrow('Service Unavailable');
    expect(updateCalls).toHaveLength(0);
  });

  it('marks the case expired when the member has left the server (10007)', async () => {
    const { ctx, updateCalls } = buildLookupFailure({
      member: Object.assign(new Error('Unknown Member'), { code: 10007 }),
    });
    await expireJob.processor(ctx, fakeJob(CASE_ID));
    expect(updateCalls).toHaveLength(1);
  });

  it('keeps the case active and rethrows when the guild lookup fails during an outage', async () => {
    const { ctx, updateCalls } = buildLookupFailure({
      guild: Object.assign(new Error('Service Unavailable'), { status: 503 }),
    });
    await expect(expireJob.processor(ctx, fakeJob(CASE_ID))).rejects.toThrow('Service Unavailable');
    expect(updateCalls).toHaveLength(0);
  });

  it.each([
    ['Unknown Guild', 10004],
    ['Missing Access', 50001],
  ])('marks the case expired when the bot is no longer in the guild (%s)', async (message, code) => {
    const { ctx, updateCalls } = buildLookupFailure({ guild: Object.assign(new Error(message), { code }) });
    await expireJob.processor(ctx, fakeJob(CASE_ID));
    expect(updateCalls).toHaveLength(1);
  });
});
