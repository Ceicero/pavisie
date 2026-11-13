import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { createTestContext } from '../../sdk/testing';
import type { CommandContext, PluginContext } from '../../sdk';
import { command as levelCommand } from '../commands/level';
import { plugin } from '../index';
import { rewardReconcileJob } from '../jobs/reward-reconcile';
import { configSchema } from '../manifest';
import { rewardReconcileListKey } from '../reward-queue';
import { xpForLevel } from '../service';
import en from '../locales/en.json';

// ioredis-mock shares one keyspace across the process. Cases that write the reconcile list use their own
// guild id plus a 2026-11-13 suffix and never flushall, so they cannot wipe another test's keys.

function realT(key: string, vars?: Record<string, string | number>): string {
  const parts = key.split('.');
  let node: unknown = en;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }
  if (typeof node !== 'string') return key;
  let out = node;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

const ROLE_5 = 'role-5';
const ROLE_10 = 'role-10';
const REWARDS = [
  { id: 'r5', level: 5, roleId: ROLE_5 },
  { id: 'r10', level: 10, roleId: ROLE_10 },
];

interface RoleWrite {
  userId: string;
  ids: string[];
}

function memberWithRoles(userId: string, roleIds: string[], removed: RoleWrite[], added: RoleWrite[]) {
  return {
    id: userId,
    roles: {
      cache: new Map(roleIds.map((id) => [id, { id }])),
      add: vi.fn(async (ids: string[]) => {
        added.push({ userId, ids: [...ids] });
      }),
      remove: vi.fn(async (ids: string[]) => {
        removed.push({ userId, ids: [...ids] });
      }),
    },
  };
}

function embedText(payload: { embeds?: EmbedBuilder[] } | undefined): string {
  return payload?.embeds?.[0]?.data.description ?? '';
}

describe('level down recomputes reward roles', () => {
  async function runXpChange(opts: {
    guildId: string;
    mode: 'stack' | 'replace';
    sub: 'remove' | 'set';
    startLevel: number;
    amount: number;
    heldRoleIds: string[];
  }) {
    const userId = `user-${opts.guildId}`;
    const removed: RoleWrite[] = [];
    const added: RoleWrite[] = [];
    const levelUps: unknown[] = [];
    const replies: { embeds?: EmbedBuilder[] }[] = [];
    const profile = {
      id: `profile-${opts.guildId}`,
      guildId: opts.guildId,
      userId,
      xp: xpForLevel(opts.startLevel),
      level: opts.startLevel,
    };

    const guild = {
      id: opts.guildId,
      members: {
        fetch: vi.fn(async () => memberWithRoles(userId, opts.heldRoleIds, removed, added)),
      },
    };
    const interaction = {
      user: { id: `admin-${opts.guildId}` },
      guild,
      options: {
        getSubcommand: () => opts.sub,
        getSubcommandGroup: () => 'xp',
        getString: () => null,
        getChannel: () => null,
        getUser: () => ({ id: userId }),
        getInteger: () => opts.amount,
        getRole: () => null,
      },
      reply: vi.fn(async (payload: { embeds?: EmbedBuilder[] }) => {
        replies.push(payload);
      }),
    };

    const cfg = configSchema.parse({ leveling: { rewardMode: opts.mode } });
    const { ctx } = createTestContext({
      config: cfg,
      prismaOverrides: {
        levelReward: { findMany: async () => REWARDS },
        levelProfile: {
          findUnique: async () => ({ ...profile }),
          upsert: async (args: unknown) => {
            const update = (args as { update: { xp: number } }).update;
            profile.xp = update.xp;
            return { ...profile };
          },
          update: async (args: unknown) => {
            const data = (args as { data: { level?: number } }).data;
            if (data.level !== undefined) profile.level = data.level;
            return { ...profile };
          },
        },
      },
    });
    ctx.events.on('level.up', (event) => {
      levelUps.push(event);
    });

    const c: CommandContext = {
      interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
      ctx,
      guildId: opts.guildId,
      staffLevel: 'admin',
      locale: 'en-US' as never,
      t: realT,
      config: async <T>() => cfg as T,
    };

    await levelCommand.execute(c);
    return { removed, added, levelUps, reply: embedText(replies[0]) };
  }

  it('stack: xp remove drops roles above the new level and does not announce', async () => {
    const guildId = 'g-leveldown-stack-20261113';
    const { removed, added, levelUps, reply } = await runXpChange({
      guildId,
      mode: 'stack',
      sub: 'remove',
      startLevel: 12,
      amount: xpForLevel(12) - xpForLevel(5),
      heldRoleIds: [ROLE_5, ROLE_10],
    });

    expect(removed.flatMap((write) => write.ids)).toEqual([ROLE_10]);
    expect(added).toEqual([]);
    expect(levelUps).toEqual([]);
    expect(reply).toContain('Removed');
  });

  it('replace: xp set to 0 removes the reward role the member no longer qualifies for', async () => {
    const guildId = 'g-leveldown-replace-20261113';
    const { removed, added, levelUps, reply } = await runXpChange({
      guildId,
      mode: 'replace',
      sub: 'set',
      startLevel: 12,
      amount: 0,
      heldRoleIds: [ROLE_10],
    });

    expect(removed.flatMap((write) => write.ids)).toEqual([ROLE_10]);
    expect(added).toEqual([]);
    expect(levelUps).toEqual([]);
    expect(reply).toContain('Set');
  });
});

describe('/level reset removes reward roles before deleting profiles', () => {
  const ROLE_ID = 'role-reset-20261113';

  function buildReset(opts: { guildId: string; targetUserId: string | null; profileCount: number }) {
    const removed: string[] = [];
    const ops: string[] = [];
    const profiles = Array.from({ length: opts.profileCount }, (_, i) => ({
      id: `p-${opts.guildId}-${i}`,
      guildId: opts.guildId,
      userId: opts.targetUserId ?? `user-${opts.guildId}-${i}`,
      level: 5,
      xp: 10_000 - i,
    }));
    const findManyArgs: unknown[] = [];
    const deleteManyArgs: unknown[] = [];

    const guild = {
      id: opts.guildId,
      members: {
        fetch: vi.fn(async (userId: string) => {
          const member = memberWithRoles(userId, [ROLE_ID], [], []);
          member.roles.remove = vi.fn(async () => {
            removed.push(userId);
            ops.push(`remove:${userId}`);
          });
          return member;
        }),
      },
    };

    const replies: { embeds?: EmbedBuilder[] }[] = [];
    const interaction = {
      user: { id: `admin-${opts.guildId}` },
      guild,
      options: {
        getSubcommand: () => 'reset',
        getSubcommandGroup: () => null,
        getString: () => null,
        getChannel: () => null,
        getUser: () => (opts.targetUserId ? { id: opts.targetUserId } : null),
        getInteger: () => null,
        getRole: () => null,
      },
      reply: vi.fn(async (payload: { embeds?: EmbedBuilder[] }) => {
        replies.push(payload);
      }),
    };

    const cfg = configSchema.parse({ leveling: { rewardMode: 'stack' } });
    const { ctx, services } = createTestContext({
      config: cfg,
      prismaOverrides: {
        levelReward: {
          findMany: async () => [{ id: 'reward', level: 1, roleId: ROLE_ID }],
        },
        levelProfile: {
          findMany: async (args: unknown) => {
            findManyArgs.push(args);
            const take = (args as { take?: number }).take ?? profiles.length;
            return [...profiles].sort((a, b) => b.xp - a.xp).slice(0, take);
          },
          deleteMany: async (args: unknown) => {
            deleteManyArgs.push(args);
            ops.push('delete');
            return { count: profiles.length };
          },
        },
      },
    });
    services.register('host', {
      getGuildConfig: async () => ({ fastActions: true }),
    } as never);

    const c: CommandContext = {
      interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
      ctx,
      guildId: opts.guildId,
      staffLevel: 'admin',
      locale: 'en-US' as never,
      t: realT,
      config: async <T>() => cfg as T,
    };

    return { c, removed, ops, findManyArgs, deleteManyArgs, replies };
  }

  it('removes the member reward role, then deletes that profile', async () => {
    const guildId = 'g-reset-user-20261113';
    const targetUserId = 'user-reset-20261113';
    const built = buildReset({ guildId, targetUserId, profileCount: 1 });
    await levelCommand.execute(built.c);

    expect(built.removed).toEqual([targetUserId]);
    expect(built.ops).toEqual([`remove:${targetUserId}`, 'delete']);
    expect(built.deleteManyArgs[0]).toEqual({ where: { guildId, userId: targetUserId } });
    expect(embedText(built.replies[0])).toContain(
      realT('level.reset.doneUser', { user: `<@${targetUserId}>` }),
    );
  });

  it('caps role removal at 500 members and still deletes every profile', async () => {
    const guildId = 'g-reset-cap-20261113';
    const built = buildReset({ guildId, targetUserId: null, profileCount: 501 });
    await levelCommand.execute(built.c);

    expect(built.removed).toHaveLength(500);
    expect(built.removed).toContain('user-g-reset-cap-20261113-0');
    expect(built.removed).not.toContain('user-g-reset-cap-20261113-500');
    expect(built.ops.indexOf('delete')).toBe(500);
    expect(built.deleteManyArgs[0]).toEqual({ where: { guildId } });
    const take = (built.findManyArgs[0] as { take?: number }).take;
    expect(take).toBe(500);
    expect(embedText(built.replies[0])).toContain(realT('level.reset.doneAll', { count: 501 }));
  });
});

describe('reward reconcile job', () => {
  it('is registered on the engagement plugin', () => {
    expect(plugin.jobs?.map((job) => job.name)).toContain('reward-reconcile');
  });

  it('drains the list and syncs each member, including a deleted profile', async () => {
    const downGuild = 'g-reconcile-down-20261113';
    const clearGuild = 'g-reconcile-clear-20261113';
    const downUser = 'user-reconcile-down-20261113';
    const clearUser = 'user-reconcile-clear-20261113';
    const removed: RoleWrite[] = [];
    const added: RoleWrite[] = [];

    const downMember = memberWithRoles(downUser, [ROLE_5, ROLE_10], removed, added);
    const clearMember = memberWithRoles(clearUser, [ROLE_5], removed, added);
    const members = new Map<string, ReturnType<typeof memberWithRoles>>([
      [`${downGuild}:${downUser}`, downMember],
      [`${clearGuild}:${clearUser}`, clearMember],
    ]);

    const { ctx, redis } = createTestContext({
      config: configSchema.parse({ leveling: { rewardMode: 'stack' } }),
      prismaOverrides: {
        levelReward: { findMany: async () => REWARDS },
        levelProfile: {
          findUnique: async (args: unknown) => {
            const key = (args as { where: { guildId_userId: { guildId: string; userId: string } } }).where
              .guildId_userId;
            if (key.guildId === downGuild && key.userId === downUser) {
              return { guildId: downGuild, userId: downUser, level: 6, xp: xpForLevel(6) };
            }
            return null;
          },
        },
      },
      overrides: {
        client: {
          guilds: {
            fetch: async (guildId: string) => ({
              id: guildId,
              members: {
                fetch: async (userId: string) => {
                  const member = members.get(`${guildId}:${userId}`);
                  if (!member) throw new Error('missing member');
                  return member;
                },
              },
            }),
          },
        } as unknown as PluginContext['client'],
      },
    });

    const key = rewardReconcileListKey();
    await redis.rpush(
      key,
      'not-json',
      JSON.stringify({ guildId: downGuild, userId: downUser }),
      JSON.stringify({ guildId: clearGuild, userId: clearUser }),
    );

    await rewardReconcileJob.processor(ctx, {} as never);

    const ours = (await redis.lrange(key, 0, -1)).flatMap((raw) => {
      try {
        const entry = JSON.parse(raw) as { guildId: string };
        return entry.guildId === downGuild || entry.guildId === clearGuild ? [entry] : [];
      } catch {
        return [];
      }
    });
    expect(ours).toEqual([]);
    expect(removed.find((write) => write.userId === downUser)?.ids).toEqual([ROLE_10]);
    expect(removed.find((write) => write.userId === clearUser)?.ids).toEqual([ROLE_5]);
    expect(added).toEqual([]);
  });
});
