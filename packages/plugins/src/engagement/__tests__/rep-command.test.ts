import { describe, expect, it, vi } from 'vitest';
import { userMention } from 'discord.js';
import type { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { PermissionError, redisKey } from '@pavisie/core';
import { createTestContext, type PrismaStubOverrides, type RecordedPrismaCall } from '../../sdk/testing';
import type { CommandContext } from '../../sdk';
import { command as repCommand } from '../commands/rep';
import { configSchema } from '../manifest';
import en from '../locales/en.json';

/** Looks a dotted key up in the plugin's real `en.json` with `{var}` interpolation (same stand-in as
 * __tests__/level-announce.test.ts). */
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
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
}

// ioredis-mock shares one keyspace across clients (see service.test.ts). Cooldown keys are
// `pavisie:engagement:repcooldown:<guildId>:<userId>`, so every case that reads or writes one uses its own
// guild id stamped with this date.
const DATE = '20261118';

type Sub = 'give' | 'check' | 'leaderboard' | 'revoke';

interface FakeUser {
  id: string;
  bot: boolean;
  username: string;
  displayAvatarURL: () => string;
}

function fakeUser(id: string, opts?: { bot?: boolean; username?: string }): FakeUser {
  return {
    id,
    bot: opts?.bot ?? false,
    username: opts?.username ?? id,
    displayAvatarURL: () => `https://cdn.example/${id}.png`,
  };
}

interface BuildOpts {
  guildId: string;
  sub: Sub;
  staffLevel?: CommandContext['staffLevel'];
  repEnabled?: boolean;
  actorId?: string;
  /** `undefined` makes `getUser` return null so `/rep check` falls back to the actor. */
  target?: FakeUser | null;
  reason?: string | null;
  amount?: number | null;
  prismaOverrides?: PrismaStubOverrides;
}

function build(opts: BuildOpts) {
  const replies: { embeds?: EmbedBuilder[]; ephemeral?: boolean }[] = [];
  const tCalls: { key: string; vars?: Record<string, string | number> }[] = [];
  const actor = fakeUser(opts.actorId ?? 'giver-1', { username: 'Giver' });

  const interaction = {
    user: actor,
    options: {
      getSubcommand: () => opts.sub,
      getUser: (name: string) => (name === 'user' ? (opts.target === undefined ? null : opts.target) : null),
      getString: (name: string) => (name === 'reason' ? (opts.reason ?? null) : null),
      getInteger: (name: string) => (name === 'amount' ? (opts.amount ?? null) : null),
    },
    reply: vi.fn(async (payload: { embeds?: EmbedBuilder[]; ephemeral?: boolean }) => {
      replies.push(payload);
    }),
  };

  const cfg = configSchema.parse({ rep: { enabled: opts.repEnabled ?? true } });
  const { ctx, prismaCalls, redis } = createTestContext({
    config: cfg,
    prismaOverrides: opts.prismaOverrides,
  });

  const c: CommandContext = {
    interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
    ctx,
    guildId: opts.guildId,
    staffLevel: opts.staffLevel ?? 'member',
    locale: 'en-US' as never,
    t: (key, vars) => {
      tCalls.push({ key, vars });
      return realT(key, vars);
    },
    config: async <T>() => cfg as T,
  };

  return { c, replies, tCalls, prismaCalls, redis, actor };
}

function replyDescription(replies: { embeds?: EmbedBuilder[] }[]): string {
  return replies[0]?.embeds?.[0]?.data.description ?? '';
}

function repCreates(calls: RecordedPrismaCall[]): RecordedPrismaCall[] {
  return calls.filter((call) => call.model === 'reputationEvent' && call.method === 'create');
}

function cooldownKey(guildId: string, userId: string): string {
  return redisKey('engagement', 'repcooldown', guildId, userId);
}

describe('/rep give', () => {
  it('replies with errors.repBot for a bot and does not take a cooldown or write a row', async () => {
    const guildId = `g-rep-bot-${DATE}`;
    const actorId = 'giver-bot-case';
    const { c, replies, tCalls, prismaCalls, redis } = build({
      guildId,
      sub: 'give',
      actorId,
      target: fakeUser('target-bot', { bot: true, username: 'HelperBot' }),
    });

    await repCommand.execute(c);

    expect(replies[0]?.ephemeral).toBe(true);
    expect(replyDescription(replies)).toBe(`❌ ${realT('errors.repBot')}`);
    expect(tCalls).toContainEqual({ key: 'errors.repBot', vars: undefined });
    expect(repCreates(prismaCalls)).toEqual([]);
    expect(await redis.get(cooldownKey(guildId, actorId))).toBeNull();
  });

  it('replies with errors.selfRep when the target is the giver', async () => {
    const guildId = `g-rep-self-${DATE}`;
    const actorId = 'giver-self-case';
    const { c, replies, tCalls, prismaCalls, redis } = build({
      guildId,
      sub: 'give',
      actorId,
      target: fakeUser(actorId, { username: 'Giver' }),
    });

    await repCommand.execute(c);

    expect(replies[0]?.ephemeral).toBe(true);
    expect(replyDescription(replies)).toBe(`❌ ${realT('errors.selfRep')}`);
    expect(tCalls).toContainEqual({ key: 'errors.selfRep', vars: undefined });
    expect(tCalls.some((call) => call.key === 'errors.repBot')).toBe(false);
    expect(repCreates(prismaCalls)).toEqual([]);
    expect(await redis.get(cooldownKey(guildId, actorId))).toBeNull();
  });

  it('replies with errors.repCooldown when the giver is on cooldown', async () => {
    const guildId = `g-rep-cooldown-${DATE}`;
    const actorId = 'giver-cooldown-case';
    const { c, replies, tCalls, prismaCalls, redis } = build({
      guildId,
      sub: 'give',
      actorId,
      target: fakeUser('target-cooldown', { username: 'Thanked' }),
    });
    await redis.set(cooldownKey(guildId, actorId), '1', 'PX', 24 * 3_600_000);

    await repCommand.execute(c);

    const cooldown = tCalls.find((call) => call.key === 'errors.repCooldown');
    expect(replies[0]?.ephemeral).toBe(true);
    expect(cooldown?.vars?.resetAt).toEqual(expect.any(Number));
    expect(replyDescription(replies)).toBe(
      `❌ ${realT('errors.repCooldown', { resetAt: cooldown?.vars?.resetAt ?? 0 })}`,
    );
    expect(repCreates(prismaCalls)).toEqual([]);
  });
});

describe('/rep when reputation is disabled', () => {
  it('blocks give', async () => {
    const guildId = `g-rep-disabled-give-${DATE}`;
    const actorId = 'giver-disabled';
    const { c, replies, tCalls, prismaCalls, redis } = build({
      guildId,
      sub: 'give',
      actorId,
      repEnabled: false,
      target: fakeUser('target-disabled', { username: 'Thanked' }),
    });

    await repCommand.execute(c);

    expect(replies[0]?.ephemeral).toBe(true);
    expect(replyDescription(replies)).toBe(`❌ ${realT('errors.repDisabled')}`);
    expect(tCalls).toContainEqual({ key: 'errors.repDisabled', vars: undefined });
    expect(repCreates(prismaCalls)).toEqual([]);
    expect(await redis.get(cooldownKey(guildId, actorId))).toBeNull();
  });

  it('blocks check', async () => {
    const { c, replies, prismaCalls } = build({
      guildId: `g-rep-disabled-check-${DATE}`,
      sub: 'check',
      repEnabled: false,
      target: fakeUser('target-check', { username: 'Thanked' }),
      prismaOverrides: {
        reputationEvent: {
          aggregate: async () => ({ _sum: { amount: 4 }, _count: 2 }),
        },
      },
    });

    await repCommand.execute(c);

    expect(replyDescription(replies)).toBe(`❌ ${realT('errors.repDisabled')}`);
    expect(prismaCalls.filter((call) => call.method === 'aggregate')).toEqual([]);
  });

  it('blocks leaderboard', async () => {
    const { c, replies, prismaCalls } = build({
      guildId: `g-rep-disabled-board-${DATE}`,
      sub: 'leaderboard',
      repEnabled: false,
      prismaOverrides: {
        reputationEvent: {
          groupBy: async () => [{ toUserId: 'someone', _sum: { amount: 3 } }],
        },
      },
    });

    await repCommand.execute(c);

    expect(replyDescription(replies)).toBe(`❌ ${realT('errors.repDisabled')}`);
    expect(prismaCalls.filter((call) => call.method === 'groupBy')).toEqual([]);
  });

  it('still revokes', async () => {
    const guildId = `g-rep-disabled-revoke-${DATE}`;
    const actorId = 'admin-disabled';
    const targetId = 'target-revoke';
    const { c, replies, prismaCalls } = build({
      guildId,
      sub: 'revoke',
      staffLevel: 'admin',
      repEnabled: false,
      actorId,
      target: fakeUser(targetId, { username: 'Adjusted' }),
      amount: 2,
    });

    await repCommand.execute(c);

    expect(replies[0]?.ephemeral).toBe(true);
    expect(replyDescription(replies)).toBe(
      `✅ ${realT('rep.revoke.success', { amount: 2, user: userMention(targetId) })}`,
    );
    expect(repCreates(prismaCalls)).toEqual([
      {
        model: 'reputationEvent',
        method: 'create',
        args: [
          {
            data: {
              guildId,
              fromUserId: actorId,
              toUserId: targetId,
              amount: -2,
              reason: 'Revoked by staff',
            },
          },
        ],
      },
    ]);
  });
});

describe('/rep revoke', () => {
  it('rejects a moderator and writes nothing', async () => {
    const { c, replies, prismaCalls } = build({
      guildId: `g-rep-revoke-mod-${DATE}`,
      sub: 'revoke',
      staffLevel: 'moderator',
      actorId: 'mod-1',
      target: fakeUser('target-mod', { username: 'Adjusted' }),
      amount: 1,
    });

    await expect(repCommand.execute(c)).rejects.toBeInstanceOf(PermissionError);
    expect(replies).toEqual([]);
    expect(repCreates(prismaCalls)).toEqual([]);
  });
});

describe('/rep leaderboard', () => {
  it('drops non-positive totals and renders rep.leaderboard.row', async () => {
    const { c, replies, tCalls } = build({
      guildId: `g-rep-board-${DATE}`,
      sub: 'leaderboard',
      prismaOverrides: {
        reputationEvent: {
          groupBy: async () => [
            { toUserId: 'pos-high', _sum: { amount: 5 } },
            { toUserId: 'zero', _sum: { amount: 0 } },
            { toUserId: 'neg', _sum: { amount: -4 } },
            { toUserId: 'missing', _sum: { amount: null } },
            { toUserId: 'pos-low', _sum: { amount: 2 } },
          ],
        },
      },
    });

    await repCommand.execute(c);

    const high = `**#1** ${userMention('pos-high')} — 5 reputation`;
    const low = `**#2** ${userMention('pos-low')} — 2 reputation`;
    expect(realT('rep.leaderboard.row', { rank: 1, user: userMention('pos-high'), amount: 5 })).toBe(high);
    expect(realT('rep.leaderboard.row', { rank: 2, user: userMention('pos-low'), amount: 2 })).toBe(low);
    expect(replyDescription(replies)).toBe(`• ${high}\n• ${low}`);
    expect(tCalls.filter((call) => call.key === 'rep.leaderboard.row')).toEqual([
      { key: 'rep.leaderboard.row', vars: { rank: 1, user: userMention('pos-high'), amount: 5 } },
      { key: 'rep.leaderboard.row', vars: { rank: 2, user: userMention('pos-low'), amount: 2 } },
    ]);
  });
});

describe('/rep check', () => {
  it('renders the localized reputation and times-thanked field names', async () => {
    const target = fakeUser('target-check', { username: 'Thanked' });
    const { c, replies, tCalls } = build({
      guildId: `g-rep-check-${DATE}`,
      sub: 'check',
      target,
      prismaOverrides: {
        reputationEvent: {
          aggregate: async () => ({ _sum: { amount: 12 }, _count: 4 }),
        },
      },
    });

    await repCommand.execute(c);

    expect(realT('rep.check.fieldTotal')).toBe('Reputation');
    expect(realT('rep.check.fieldCount')).toBe('Times thanked');
    const embed = replies[0]?.embeds?.[0];
    expect(embed?.data.title).toBe(realT('rep.check.title', { name: target.username }));
    expect(embed?.data.fields).toEqual([
      { name: realT('rep.check.fieldTotal'), value: '12', inline: true },
      { name: realT('rep.check.fieldCount'), value: '4', inline: true },
    ]);
    expect(tCalls).toContainEqual({ key: 'rep.check.fieldTotal', vars: undefined });
    expect(tCalls).toContainEqual({ key: 'rep.check.fieldCount', vars: undefined });
  });
});
