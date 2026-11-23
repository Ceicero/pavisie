import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import type { Guild, GuildMember } from 'discord.js';
import { createTestContext } from '../../sdk/testing';
import type { PluginContext } from '../../sdk';
import { applyLevelUp, REWARD_ROLE_SYNC_LIMIT, syncMemberRewardRoles } from '../level-actions';
import { configSchema, type EngagementLevelingConfig } from '../manifest';

const GUILD_ID = 'guild-1';
const USER_ID = 'user-1';

const REWARDS = [
  { id: 'r5', level: 5, roleId: 'role-5' },
  { id: 'r10', level: 10, roleId: 'role-10' },
  { id: 'r20', level: 20, roleId: 'role-20' },
];

// One context for the whole file: createTestContext builds an ioredis-mock per call, and dozens of them
// trip Node's MaxListeners warning. The stub is stateless apart from recorded calls, which tests reset.
const warn = vi.fn();
let rewardRows: unknown[] = REWARDS;
const shared = createTestContext({
  prismaOverrides: { levelReward: { findMany: async () => rewardRows } },
  overrides: { logger: { warn } as unknown as PluginContext['logger'] },
});

beforeEach(() => {
  warn.mockClear();
  shared.prismaCalls.length = 0;
  rewardRows = REWARDS;
});

function buildContext(rows?: unknown[]) {
  if (rows) rewardRows = rows;
  return { ctx: shared.ctx, events: shared.events, prismaCalls: shared.prismaCalls, warn };
}

function buildMember(
  roleIds: string[],
  failures: { add?: boolean; remove?: boolean } = {},
): {
  member: GuildMember;
  add: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  dm: ReturnType<typeof vi.fn>;
} {
  const add = vi.fn(async () => {
    if (failures.add) throw new Error('Missing Permissions');
  });
  const remove = vi.fn(async () => {
    if (failures.remove) throw new Error('Missing Permissions');
  });
  const dm = vi.fn(async () => undefined);
  const member = {
    id: USER_ID,
    user: { id: USER_ID, send: dm },
    roles: { cache: new Map(roleIds.map((id) => [id, { id }])), add, remove },
  } as unknown as GuildMember;
  return { member, add, remove, dm };
}

describe('syncMemberRewardRoles', () => {
  it('returns false and writes nothing when the guild has no rewards', async () => {
    const { ctx } = buildContext([]);
    const { member, add, remove } = buildMember(['role-5']);
    const result = await syncMemberRewardRoles({ ctx, guildId: GUILD_ID, member, level: 30, mode: 'stack' });
    expect(result).toBe(false);
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('reads rewards for the guild when none are preloaded', async () => {
    const { ctx, prismaCalls } = buildContext();
    const { member, add } = buildMember([]);
    await syncMemberRewardRoles({ ctx, guildId: GUILD_ID, member, level: 5, mode: 'stack' });
    const reads = prismaCalls.filter((c) => c.model === 'levelReward' && c.method === 'findMany');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.args[0]).toEqual({ where: { guildId: GUILD_ID } });
    expect(add).toHaveBeenCalledWith(['role-5'], expect.any(String));
  });

  it('skips the prisma query when rewards are preloaded', async () => {
    const { ctx, prismaCalls } = buildContext();
    const { member, add } = buildMember([]);
    const result = await syncMemberRewardRoles({
      ctx,
      guildId: GUILD_ID,
      member,
      level: 10,
      mode: 'stack',
      rewards: [{ level: 1, roleId: 'only-role' }],
    });
    expect(result).toBe(true);
    expect(prismaCalls.filter((c) => c.model === 'levelReward')).toHaveLength(0);
    expect(add).toHaveBeenCalledWith(['only-role'], expect.any(String));
  });

  it('caps a sync pass at 500 members', () => {
    expect(REWARD_ROLE_SYNC_LIMIT).toBe(500);
  });

  describe('stack mode', () => {
    it('adds every earned missing role on a level up', async () => {
      const { ctx } = buildContext();
      const { member, add, remove } = buildMember(['role-5']);
      const result = await syncMemberRewardRoles({
        ctx,
        guildId: GUILD_ID,
        member,
        level: 12,
        mode: 'stack',
      });
      expect(result).toBe(true);
      expect(add).toHaveBeenCalledTimes(1);
      expect(add.mock.calls[0]![0]).toEqual(['role-10']);
      expect(remove).not.toHaveBeenCalled();
    });

    it('adds all earned roles when the member holds none', async () => {
      const { ctx } = buildContext();
      const { member, add } = buildMember([]);
      await syncMemberRewardRoles({ ctx, guildId: GUILD_ID, member, level: 25, mode: 'stack' });
      expect([...(add.mock.calls[0]![0] as string[])].sort()).toEqual(['role-10', 'role-20', 'role-5']);
    });

    it('removes reward roles above the new level on a level drop and keeps the rest', async () => {
      const { ctx } = buildContext();
      const { member, add, remove } = buildMember(['role-5', 'role-10', 'role-20']);
      const result = await syncMemberRewardRoles({
        ctx,
        guildId: GUILD_ID,
        member,
        level: 10,
        mode: 'stack',
      });
      expect(result).toBe(true);
      expect(add).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]![0]).toEqual(['role-20']);
    });

    it('strips every reward role at level 0', async () => {
      const { ctx } = buildContext();
      const { member, add, remove } = buildMember(['role-5', 'role-10', 'role-20']);
      await syncMemberRewardRoles({ ctx, guildId: GUILD_ID, member, level: 0, mode: 'stack' });
      expect(add).not.toHaveBeenCalled();
      expect([...(remove.mock.calls[0]![0] as string[])].sort()).toEqual(['role-10', 'role-20', 'role-5']);
    });

    it('never removes non-reward roles', async () => {
      const { ctx } = buildContext();
      const { member, remove } = buildMember(['role-5', 'role-20', 'mod-role', 'booster']);
      await syncMemberRewardRoles({ ctx, guildId: GUILD_ID, member, level: 0, mode: 'stack' });
      const removed = remove.mock.calls[0]![0] as string[];
      expect(removed).not.toContain('mod-role');
      expect(removed).not.toContain('booster');
      expect([...removed].sort()).toEqual(['role-20', 'role-5']);
    });
  });

  describe('replace mode', () => {
    it('adds the highest earned reward and removes lower ones', async () => {
      const { ctx } = buildContext();
      const { member, add, remove } = buildMember(['role-5', 'other']);
      const result = await syncMemberRewardRoles({
        ctx,
        guildId: GUILD_ID,
        member,
        level: 12,
        mode: 'replace',
      });
      expect(result).toBe(true);
      expect(add.mock.calls[0]![0]).toEqual(['role-10']);
      expect(remove.mock.calls[0]![0]).toEqual(['role-5']);
    });

    it('on a drop keeps only the highest still-earned reward', async () => {
      const { ctx } = buildContext();
      const { member, add, remove } = buildMember(['role-20']);
      await syncMemberRewardRoles({ ctx, guildId: GUILD_ID, member, level: 6, mode: 'replace' });
      expect(add.mock.calls[0]![0]).toEqual(['role-5']);
      expect(remove.mock.calls[0]![0]).toEqual(['role-20']);
    });

    it('removes every held reward role when below all rewards', async () => {
      const { ctx } = buildContext();
      const { member, add, remove } = buildMember(['role-10', 'role-20', 'other']);
      const result = await syncMemberRewardRoles({
        ctx,
        guildId: GUILD_ID,
        member,
        level: 2,
        mode: 'replace',
      });
      expect(result).toBe(true);
      expect(add).not.toHaveBeenCalled();
      expect([...(remove.mock.calls[0]![0] as string[])].sort()).toEqual(['role-10', 'role-20']);
    });

    it('strips all reward roles at level 0 but leaves other roles', async () => {
      const { ctx } = buildContext();
      const { member, add, remove } = buildMember(['role-5', 'role-10', 'other']);
      await syncMemberRewardRoles({ ctx, guildId: GUILD_ID, member, level: 0, mode: 'replace' });
      expect(add).not.toHaveBeenCalled();
      expect([...(remove.mock.calls[0]![0] as string[])].sort()).toEqual(['role-10', 'role-5']);
    });
  });

  it.each([
    ['stack', ['role-5', 'role-10']],
    ['replace', ['role-10']],
  ] as const)('returns false with no writes when nothing needs to change (%s)', async (mode, held) => {
    const { ctx } = buildContext();
    const { member, add, remove } = buildMember([...held, 'other']);
    const result = await syncMemberRewardRoles({ ctx, guildId: GUILD_ID, member, level: 12, mode });
    expect(result).toBe(false);
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  describe('a role shared by several reward levels', () => {
    const dup = [
      { level: 5, roleId: 'A' },
      { level: 10, roleId: 'A' },
      { level: 20, roleId: 'B' },
    ];
    const sync = async (held: string[], level: number, mode: 'stack' | 'replace') => {
      const { ctx } = buildContext();
      const m = buildMember(held);
      const result = await syncMemberRewardRoles({
        ctx,
        guildId: GUILD_ID,
        member: m.member,
        level,
        mode,
        rewards: dup,
      });
      return { result, add: m.add, remove: m.remove };
    };

    it('replace@12 holding A: no writes', async () => {
      const { result, add, remove } = await sync(['A'], 12, 'replace');
      expect(result).toBe(false);
      expect(add).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it('replace@7 holding A and B: removes only B', async () => {
      const { add, remove } = await sync(['A', 'B'], 7, 'replace');
      expect(add).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]![0]).toEqual(['B']);
    });

    it('replace@3 holding A: removes A', async () => {
      const { remove } = await sync(['A'], 3, 'replace');
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]![0]).toEqual(['A']);
    });

    it('stack@7 holding A: keeps A', async () => {
      const { result, add, remove } = await sync(['A'], 7, 'stack');
      expect(result).toBe(false);
      expect(add).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it('stack@3 holding A: removes A', async () => {
      const { remove } = await sync(['A'], 3, 'stack');
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]![0]).toEqual(['A']);
    });
  });

  it('returns false and warns instead of throwing when roles.add rejects', async () => {
    const { ctx, warn } = buildContext();
    const { member, remove } = buildMember(['role-5'], { add: true });
    await expect(
      syncMemberRewardRoles({ ctx, guildId: GUILD_ID, member, level: 12, mode: 'replace' }),
    ).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      guildId: GUILD_ID,
      userId: USER_ID,
      err: 'Missing Permissions',
    });
  });

  it('returns false and warns instead of throwing when roles.remove rejects', async () => {
    const { ctx, warn } = buildContext();
    const { member } = buildMember(['role-20'], { remove: true });
    await expect(
      syncMemberRewardRoles({ ctx, guildId: GUILD_ID, member, level: 0, mode: 'stack' }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ guildId: GUILD_ID });
  });

  it('uses default reasons mentioning the level and mode', async () => {
    const { ctx } = buildContext();
    const { member, add, remove } = buildMember(['role-5']);
    await syncMemberRewardRoles({ ctx, guildId: GUILD_ID, member, level: 12, mode: 'replace' });
    expect(add.mock.calls[0]![1]).toContain('level 12');
    expect(remove.mock.calls[0]![1]).toContain('replace');
  });

  it('passes custom reasons through', async () => {
    const { ctx } = buildContext();
    const { member, add, remove } = buildMember(['role-5']);
    await syncMemberRewardRoles({
      ctx,
      guildId: GUILD_ID,
      member,
      level: 12,
      mode: 'replace',
      addReason: 'custom add',
      removeReason: 'custom remove',
    });
    expect(add.mock.calls[0]![1]).toBe('custom add');
    expect(remove.mock.calls[0]![1]).toBe('custom remove');
  });
});

describe('applyLevelUp', () => {
  interface ChannelSpec {
    botCanSend?: boolean;
    sendRejects?: boolean;
  }

  function buildGuild(channels: Record<string, ChannelSpec> = {}) {
    const sends: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const [id, spec] of Object.entries(channels)) {
      sends[id] = vi.fn(async () => {
        if (spec.sendRejects) throw new Error('send failed');
      });
    }
    const guild = {
      id: GUILD_ID,
      members: { me: { id: 'bot-1' } },
      channels: {
        fetch: vi.fn(async (id: string) => {
          const spec = channels[id];
          if (!spec) return null;
          return {
            id,
            type: ChannelType.GuildText,
            isTextBased: () => true,
            permissionsFor: () => ({ has: () => spec.botCanSend ?? true }),
            send: sends[id],
          };
        }),
      },
    } as unknown as Guild;
    return { guild, sends };
  }

  function levelingConfig(patch: Partial<EngagementLevelingConfig>): EngagementLevelingConfig {
    return { ...configSchema.parse({}).leveling, ...patch };
  }

  async function run(opts: {
    config: Partial<EngagementLevelingConfig>;
    member?: GuildMember | null;
    guild?: Guild;
    sourceChannelId?: string;
    newLevel?: number;
    ctx?: ReturnType<typeof buildContext>;
  }) {
    const built = opts.ctx ?? buildContext();
    const emitted: unknown[] = [];
    const listener = (payload: unknown) => {
      emitted.push(payload);
    };
    built.events.on('level.up', listener);
    try {
      await applyLevelUp({
        ctx: built.ctx,
        guild: opts.guild ?? buildGuild().guild,
        member: opts.member === undefined ? buildMember([]).member : opts.member,
        guildId: GUILD_ID,
        userId: USER_ID,
        newLevel: opts.newLevel ?? 5,
        config: levelingConfig(opts.config),
        sourceChannelId: opts.sourceChannelId,
      });
    } finally {
      built.events.off('level.up', listener);
    }
    return { emitted, warn: built.warn };
  }

  it("'none' sends nothing and DMs nobody but still emits level.up", async () => {
    const { guild } = buildGuild({ c1: {} });
    const { member, dm } = buildMember([]);
    const { emitted } = await run({
      config: { levelUpChannel: 'none' },
      member,
      guild,
      sourceChannelId: 'c1',
    });
    expect(dm).not.toHaveBeenCalled();
    expect(guild.channels.fetch).not.toHaveBeenCalled();
    expect(emitted).toEqual([{ guildId: GUILD_ID, userId: USER_ID, level: 5 }]);
  });

  it("'dm' DMs the member with every placeholder rendered", async () => {
    const { member, dm } = buildMember([]);
    const { emitted } = await run({
      config: { levelUpChannel: 'dm', levelUpMessage: '{user} hit {level}! gg {user}, level {level}' },
      member,
      newLevel: 7,
    });
    expect(dm).toHaveBeenCalledTimes(1);
    expect(dm).toHaveBeenCalledWith(`<@${USER_ID}> hit 7! gg <@${USER_ID}>, level 7`);
    expect(emitted).toEqual([{ guildId: GUILD_ID, userId: USER_ID, level: 7 }]);
  });

  it("'dm' emits level.up when the member is null (no DM possible)", async () => {
    const { emitted } = await run({ config: { levelUpChannel: 'dm' }, member: null });
    expect(emitted).toHaveLength(1);
  });

  it("'dm' does not throw when the DM fails", async () => {
    const { member, dm } = buildMember([]);
    dm.mockRejectedValueOnce(new Error('Cannot send messages to this user'));
    const { emitted } = await run({ config: { levelUpChannel: 'dm' }, member });
    expect(dm).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(1);
  });

  it("'current' sends to the source channel", async () => {
    const { guild, sends } = buildGuild({ src: {}, other: {} });
    await run({
      config: { levelUpChannel: 'current', levelUpMessage: 'GG {user} -> {level}' },
      guild,
      sourceChannelId: 'src',
      newLevel: 3,
    });
    expect(sends.src).toHaveBeenCalledWith({ content: `GG <@${USER_ID}> -> 3` });
    expect(sends.other).not.toHaveBeenCalled();
  });

  it("'current' without a sourceChannelId sends nothing", async () => {
    const { guild, sends } = buildGuild({ src: {} });
    const { emitted } = await run({ config: { levelUpChannel: 'current' }, guild });
    expect(guild.channels.fetch).not.toHaveBeenCalled();
    expect(sends.src).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
  });

  it('a fixed channel id sends there, ignoring the source channel', async () => {
    const { guild, sends } = buildGuild({ fixed: {}, src: {} });
    await run({ config: { levelUpChannel: 'fixed' }, guild, sourceChannelId: 'src' });
    expect(sends.fixed).toHaveBeenCalledTimes(1);
    expect(sends.src).not.toHaveBeenCalled();
  });

  it('does not throw or send when the channel cannot be resolved', async () => {
    const { guild, sends } = buildGuild({ other: {} });
    const { emitted } = await run({ config: { levelUpChannel: 'missing' }, guild });
    expect(guild.channels.fetch).toHaveBeenCalledWith('missing');
    expect(sends.other).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
  });

  it('does not send when the bot lacks send permission', async () => {
    const { guild, sends } = buildGuild({ locked: { botCanSend: false } });
    const { emitted } = await run({ config: { levelUpChannel: 'locked' }, guild });
    expect(guild.channels.fetch).toHaveBeenCalledWith('locked');
    expect(sends.locked).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
  });

  it('does not throw and still emits when channel.send rejects', async () => {
    const { guild, sends } = buildGuild({ broken: { sendRejects: true } });
    const { emitted } = await run({ config: { levelUpChannel: 'broken' }, guild });
    expect(sends.broken).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([{ guildId: GUILD_ID, userId: USER_ID, level: 5 }]);
  });

  it('with a null member skips role writes but still announces and emits', async () => {
    const built = buildContext();
    const { guild, sends } = buildGuild({ c1: {} });
    const { emitted } = await run({
      config: { levelUpChannel: 'c1' },
      member: null,
      guild,
      ctx: built,
    });
    expect(built.prismaCalls.filter((c) => c.model === 'levelReward')).toHaveLength(0);
    expect(sends.c1).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(1);
  });

  it('applies reward roles for the new level using the configured mode', async () => {
    const { member, add, remove } = buildMember(['role-5']);
    await run({ config: { levelUpChannel: 'none', rewardMode: 'replace' }, member, newLevel: 10 });
    expect(add.mock.calls[0]![0]).toEqual(['role-10']);
    expect(remove.mock.calls[0]![0]).toEqual(['role-5']);
  });

  it('a reward role failure blocks neither the announcement nor the event', async () => {
    const built = buildContext();
    const { guild, sends } = buildGuild({ c1: {} });
    const { member, add } = buildMember([], { add: true });
    const { emitted, warn } = await run({
      config: { levelUpChannel: 'c1' },
      member,
      guild,
      ctx: built,
    });
    expect(add).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(sends.c1).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(1);
  });
});
