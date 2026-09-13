import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { Prisma } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import type { CommandContext, ComponentContext, PluginContext } from '../../sdk';
import en from '../locales/en.json';

/** Same P2002 construction as `tickets/__tests__/number.test.ts`'s `p2002()`. */
function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.0.0',
  });
}

// `command.ts`/`service.ts` both import from `./steam` — mocking it here intercepts BOTH the command's own
// validation call (`handleLink`) and `refreshMemberStats`'s internal calls (unmocked, real `service.ts`),
// same hoisting trick as `__tests__/service.test.ts`.
const mocks = vi.hoisted(() => ({
  resolveSteamId: vi.fn(),
  getGameStats: vi.fn(),
  getPlayerSummary: vi.fn(),
}));
vi.mock('../steam', () => mocks);

import { command as dbdCommand, dbdComponents } from '../commands/dbd';

/** Looks a dotted key up in the plugin's real `en.json` with `{var}` interpolation (same stand-in used by
 * `integrations/__tests__/twitch-command.test.ts`). */
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
  for (const [k, v] of Object.entries(vars ?? {})) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

const GUILD_ID = 'guild-1';
const CALLER_ID = '111111111111111111';
const OTHER_ID = '222222222222222222';

interface ReplyPayload {
  embeds?: EmbedBuilder[];
  components?: unknown[];
  ephemeral?: boolean;
}

interface FakeUser {
  id: string;
  username: string;
  displayAvatarURL: () => string;
}

function makeUser(id: string, username: string): FakeUser {
  return { id, username, displayAvatarURL: () => `https://cdn.example/${id}.png` };
}

interface FakeOptions {
  sub: string;
  strings?: Record<string, string | null>;
  users?: Record<string, FakeUser | null>;
}

function fakeInteraction(opts: FakeOptions, caller: FakeUser) {
  const replies: ReplyPayload[] = [];
  const interaction = {
    user: caller,
    guild: { id: GUILD_ID },
    options: {
      getSubcommand: () => opts.sub,
      getString: (name: string, required?: boolean) => {
        const value = (opts.strings ?? {})[name] ?? null;
        if (required && value === null) throw new Error(`missing required string option: ${name}`);
        return value;
      },
      getUser: (name: string) => (opts.users ?? {})[name] ?? null,
    },
    reply: vi.fn(async (payload: ReplyPayload) => {
      replies.push(payload);
    }),
  };
  return { interaction, replies };
}

function buildContext(
  opts: FakeOptions,
  testCtxOverrides: Parameters<typeof createTestContext>[0] = {},
  caller: FakeUser = makeUser(CALLER_ID, 'Caller'),
): { c: CommandContext; replies: ReplyPayload[]; ctx: PluginContext } {
  const { interaction, replies } = fakeInteraction(opts, caller);
  const { ctx } = createTestContext(testCtxOverrides);

  const c: CommandContext = {
    interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
    ctx,
    guildId: GUILD_ID,
    staffLevel: 'member',
    locale: 'en-US' as never,
    t: realT,
    config: async <T>() => ({}) as T,
  };

  return { c, replies, ctx };
}

function descriptionOf(payloads: ReplyPayload[], index = 0): string {
  return payloads[index]?.embeds?.[0]?.data.description ?? '';
}

function titleOf(payloads: ReplyPayload[], index = 0): string {
  return payloads[index]?.embeds?.[0]?.data.title ?? '';
}

function fieldsOf(payloads: ReplyPayload[], index = 0): { name: string; value: string }[] {
  return payloads[index]?.embeds?.[0]?.data.fields ?? [];
}

const RESOLVED = { ok: true as const, steamId64: '76561197960287930' };

afterEach(() => {
  vi.clearAllMocks();
});

describe('/dbd link', () => {
  it('reports not-found without touching the database when Steam cannot resolve the input', async () => {
    mocks.resolveSteamId.mockResolvedValue({ ok: false, error: 'not_found' });
    const upsert = vi.fn();
    const { c, replies } = buildContext(
      { sub: 'link', strings: { account: 'nosuchvanity' } },
      { prismaOverrides: { gameAccountLink: { upsert } } },
    );

    await dbdCommand.execute(c);

    expect(upsert).not.toHaveBeenCalled();
    expect(mocks.getGameStats).not.toHaveBeenCalled();
    expect(descriptionOf(replies)).toContain(realT('dbd.link.notFound', { input: 'nosuchvanity' }));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('replies with the exact Steam privacy click-path when Game details are private', async () => {
    mocks.resolveSteamId.mockResolvedValue(RESOLVED);
    mocks.getGameStats.mockResolvedValue({ ok: false, reason: 'private' });
    const upsert = vi.fn();
    const { c, replies } = buildContext(
      { sub: 'link', strings: { account: RESOLVED.steamId64 } },
      { prismaOverrides: { gameAccountLink: { upsert } } },
    );

    await dbdCommand.execute(c);

    expect(upsert).not.toHaveBeenCalled();
    const desc = descriptionOf(replies);
    expect(desc).toContain('Steam profile → Edit Profile → Privacy Settings → Game details → Public');
    expect(desc).toContain(realT('dbd.link.private'));
  });

  it('reports no_game and error reasons distinctly', async () => {
    mocks.resolveSteamId.mockResolvedValue(RESOLVED);
    mocks.getGameStats.mockResolvedValue({ ok: false, reason: 'no_game' });
    const { c: c1, replies: r1 } = buildContext({ sub: 'link', strings: { account: RESOLVED.steamId64 } });
    await dbdCommand.execute(c1);
    expect(descriptionOf(r1)).toContain(realT('dbd.link.noGame'));

    mocks.getGameStats.mockResolvedValue({ ok: false, reason: 'error' });
    const { c: c2, replies: r2 } = buildContext({ sub: 'link', strings: { account: RESOLVED.steamId64 } });
    await dbdCommand.execute(c2);
    expect(descriptionOf(r2)).toContain(realT('dbd.link.fetchFailed'));
  });

  it('upserts the link, immediately refreshes stats, and replies ephemeral on success', async () => {
    mocks.resolveSteamId.mockResolvedValue(RESOLVED);
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: { DBD_Escape: 7 } });
    mocks.getPlayerSummary.mockResolvedValue({
      steamId: RESOLVED.steamId64,
      personaName: 'SurvivorMain',
      profileUrl: 'https://steamcommunity.com/id/survivormain',
      visibility: 3,
    });

    const upsertCalls: { where: unknown; create: Record<string, unknown> }[] = [];
    const link = {
      id: 'link-1',
      guildId: GUILD_ID,
      userId: CALLER_ID,
      provider: 'STEAM',
      externalId: RESOLVED.steamId64,
      externalName: 'SurvivorMain',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const snapshotUpsert = vi.fn(async () => ({}));
    const accountUpdate = vi.fn();
    const { c, replies } = buildContext(
      { sub: 'link', strings: { account: RESOLVED.steamId64 } },
      {
        prismaOverrides: {
          gameAccountLink: {
            // Also stands in for `refreshMemberStats`'s post-write re-verify (finding 3) — returning the link
            // means it's treated as still present, so the snapshot write proceeds.
            findUnique: async () => link,
            upsert: async (args: unknown) => {
              upsertCalls.push(args as (typeof upsertCalls)[number]);
              return link;
            },
            update: accountUpdate,
          },
          gameStatSnapshot: { upsert: snapshotUpsert },
        },
      },
    );

    await dbdCommand.execute(c);

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.where).toEqual({
      guildId_userId_provider: { guildId: GUILD_ID, userId: CALLER_ID, provider: 'STEAM' },
    });
    expect(upsertCalls[0]!.create).toMatchObject({
      guildId: GUILD_ID,
      userId: CALLER_ID,
      provider: 'STEAM',
      externalId: RESOLVED.steamId64,
      externalName: 'SurvivorMain',
    });
    // refreshMemberStats ran for real (unmocked service.ts) and wrote a curated snapshot.
    expect(snapshotUpsert).toHaveBeenCalledTimes(1);
    // The persona name already matched, so refreshMemberStats's own getPlayerSummary comparison is a no-op.
    expect(accountUpdate).not.toHaveBeenCalled();

    expect(replies[0]?.ephemeral).toBe(true);
    expect(descriptionOf(replies)).toContain(realT('dbd.link.success', { name: 'SurvivorMain' }));
  });

  it('validates via a live, cache-bypassing call curated to this game\'s stat keys', async () => {
    mocks.resolveSteamId.mockResolvedValue(RESOLVED);
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: { DBD_Escape: 1 } });
    mocks.getPlayerSummary.mockResolvedValue(null);
    const link = { id: 'link-1', guildId: GUILD_ID, userId: CALLER_ID, externalId: RESOLVED.steamId64, externalName: null };
    const { c } = buildContext(
      { sub: 'link', strings: { account: RESOLVED.steamId64 } },
      {
        prismaOverrides: {
          gameAccountLink: { findFirst: async () => null, findUnique: async () => link, upsert: async () => link },
          gameStatSnapshot: { upsert: async () => ({}) },
        },
      },
    );

    await dbdCommand.execute(c);

    expect(mocks.getGameStats).toHaveBeenCalledWith(
      expect.anything(),
      RESOLVED.steamId64,
      expect.any(Number),
      expect.objectContaining({ bypassCache: true, keepKeys: expect.arrayContaining(['DBD_Escape']) }),
    );
  });

  it('shows a distinct Steam-hiccup message for a transient failure, never the privacy click-path', async () => {
    mocks.resolveSteamId.mockResolvedValue(RESOLVED);
    mocks.getGameStats.mockResolvedValue({ ok: false, reason: 'transient' });
    const { c, replies } = buildContext({ sub: 'link', strings: { account: RESOLVED.steamId64 } });

    await dbdCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('dbd.link.transientError'));
    expect(descriptionOf(replies)).not.toContain('Privacy Settings');
  });

  it('rejects linking a Steam account already linked by another member in this guild', async () => {
    mocks.resolveSteamId.mockResolvedValue(RESOLVED);
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: { DBD_Escape: 1 } });
    const findFirst = vi.fn(async (_args: unknown) => ({ id: 'other-link', userId: OTHER_ID, externalId: RESOLVED.steamId64 }));
    const upsert = vi.fn();
    const { c, replies } = buildContext(
      { sub: 'link', strings: { account: RESOLVED.steamId64 } },
      { prismaOverrides: { gameAccountLink: { findFirst, upsert } } },
    );

    await dbdCommand.execute(c);

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect((findFirst.mock.calls[0]![0] as { where: unknown }).where).toEqual({
      guildId: GUILD_ID,
      provider: 'STEAM',
      externalId: RESOLVED.steamId64,
      NOT: { userId: CALLER_ID },
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(descriptionOf(replies)).toContain(realT('dbd.link.duplicate'));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('maps a P2002 race on the upsert (two members linking the same account at once) to the same duplicate message', async () => {
    mocks.resolveSteamId.mockResolvedValue(RESOLVED);
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: { DBD_Escape: 1 } });
    mocks.getPlayerSummary.mockResolvedValue(null);
    const upsert = vi.fn(async () => {
      throw p2002();
    });
    const { c, replies } = buildContext(
      { sub: 'link', strings: { account: RESOLVED.steamId64 } },
      { prismaOverrides: { gameAccountLink: { findFirst: async () => null, upsert } } },
    );

    await dbdCommand.execute(c);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(descriptionOf(replies)).toContain(realT('dbd.link.duplicate'));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('re-throws a non-P2002 error from the upsert rather than swallowing it as a duplicate', async () => {
    mocks.resolveSteamId.mockResolvedValue(RESOLVED);
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: {} });
    mocks.getPlayerSummary.mockResolvedValue(null);
    const upsert = vi.fn(async () => {
      throw new Error('db is down');
    });
    const { c } = buildContext(
      { sub: 'link', strings: { account: RESOLVED.steamId64 } },
      { prismaOverrides: { gameAccountLink: { findFirst: async () => null, upsert } } },
    );

    await expect(dbdCommand.execute(c)).rejects.toThrow('db is down');
  });

  it('nulls out externalName when re-linking to a DIFFERENT account and the fresh persona lookup fails', async () => {
    mocks.resolveSteamId.mockResolvedValue(RESOLVED);
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: {} });
    mocks.getPlayerSummary.mockResolvedValue(null); // fresh lookup fails
    const existingLink = {
      id: 'link-1',
      guildId: GUILD_ID,
      userId: CALLER_ID,
      provider: 'STEAM',
      externalId: 'some-other-previously-linked-id64',
      externalName: 'OldPersona',
    };
    const updateCalls: { update: Record<string, unknown> }[] = [];
    const { c } = buildContext(
      { sub: 'link', strings: { account: RESOLVED.steamId64 } },
      {
        prismaOverrides: {
          gameAccountLink: {
            findFirst: async () => null,
            findUnique: async () => existingLink,
            upsert: async (args: unknown) => {
              updateCalls.push(args as { update: Record<string, unknown> });
              return { ...existingLink, externalId: RESOLVED.steamId64, externalName: null };
            },
          },
          gameStatSnapshot: { upsert: async () => ({}) },
        },
      },
    );

    await dbdCommand.execute(c);

    expect(updateCalls[0]!.update.externalId).toBe(RESOLVED.steamId64);
    expect(updateCalls[0]!.update.externalName).toBeNull();
  });

  it('keeps the cached persona name (does not null it) when re-linking the SAME account and the lookup fails', async () => {
    mocks.resolveSteamId.mockResolvedValue(RESOLVED);
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: {} });
    mocks.getPlayerSummary.mockResolvedValue(null);
    const existingLink = {
      id: 'link-1',
      guildId: GUILD_ID,
      userId: CALLER_ID,
      provider: 'STEAM',
      externalId: RESOLVED.steamId64,
      externalName: 'KnownPersona',
    };
    const updateCalls: { update: Record<string, unknown> }[] = [];
    const { c } = buildContext(
      { sub: 'link', strings: { account: RESOLVED.steamId64 } },
      {
        prismaOverrides: {
          gameAccountLink: {
            findFirst: async () => null,
            findUnique: async () => existingLink,
            upsert: async (args: unknown) => {
              updateCalls.push(args as { update: Record<string, unknown> });
              return existingLink;
            },
          },
          gameStatSnapshot: { upsert: async () => ({}) },
        },
      },
    );

    await dbdCommand.execute(c);

    expect(updateCalls[0]!.update.externalId).toBe(RESOLVED.steamId64);
    expect(updateCalls[0]!.update.externalName).toBeUndefined(); // left as-is, not overwritten with null
  });
});

describe('/dbd unlink', () => {
  it('reports nothing to remove when there is no linked account', async () => {
    const linkDelete = vi.fn(async () => ({ count: 0 }));
    const snapshotDelete = vi.fn(async () => ({ count: 0 }));
    const { c, replies } = buildContext(
      { sub: 'unlink' },
      { prismaOverrides: { gameAccountLink: { deleteMany: linkDelete }, gameStatSnapshot: { deleteMany: snapshotDelete } } },
    );

    await dbdCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('dbd.unlink.none'));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('deletes the link and every stat snapshot for the caller in this guild', async () => {
    const linkDelete = vi.fn(async () => ({ count: 1 }));
    const snapshotDelete = vi.fn(async () => ({ count: 1 }));
    const { c, replies } = buildContext(
      { sub: 'unlink' },
      { prismaOverrides: { gameAccountLink: { deleteMany: linkDelete }, gameStatSnapshot: { deleteMany: snapshotDelete } } },
    );

    await dbdCommand.execute(c);

    expect(linkDelete).toHaveBeenCalledWith({ where: { guildId: GUILD_ID, userId: CALLER_ID, provider: 'STEAM' } });
    expect(snapshotDelete).toHaveBeenCalledWith({ where: { guildId: GUILD_ID, userId: CALLER_ID } });
    expect(descriptionOf(replies)).toContain(realT('dbd.unlink.done'));
  });
});

describe('/dbd stats', () => {
  it('gives an ephemeral hint when the caller has not linked an account', async () => {
    const { c, replies } = buildContext(
      { sub: 'stats' },
      { prismaOverrides: { gameAccountLink: { findUnique: async () => null } } },
    );

    await dbdCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('dbd.stats.unlinkedSelf'));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('gives an ephemeral hint when the target member has not linked an account', async () => {
    const other = makeUser(OTHER_ID, 'OtherMember');
    const { c, replies } = buildContext(
      { sub: 'stats', users: { member: other } },
      { prismaOverrides: { gameAccountLink: { findUnique: async () => null } } },
    );

    await dbdCommand.execute(c);

    expect(descriptionOf(replies)).toContain(
      realT('dbd.stats.unlinkedOther', { user: `<@${OTHER_ID}>` }),
    );
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('gives an ephemeral hint when linked but no snapshot has been fetched yet', async () => {
    const { c, replies } = buildContext(
      { sub: 'stats' },
      {
        prismaOverrides: {
          gameAccountLink: { findUnique: async () => ({ id: 'l1', externalName: 'Name' }) },
          gameStatSnapshot: { findUnique: async () => null },
        },
      },
    );

    await dbdCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('dbd.stats.noSnapshot', { user: `<@${CALLER_ID}>` }));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('renders a public stat card with every curated stat and a relative fetched-at timestamp', async () => {
    const fetchedAt = new Date('2026-08-20T00:00:00Z');
    const { c, replies } = buildContext(
      { sub: 'stats' },
      {
        prismaOverrides: {
          gameAccountLink: { findUnique: async () => ({ id: 'l1', externalName: 'SurvivorMain' }) },
          gameStatSnapshot: {
            findUnique: async () => ({
              stats: { escapes: 12, sacrifices: 3, kills: 0, bloodpoints: 45000, generators: 4.5, heals: 2.3, 'survivor-perfect-games': 1 },
              fetchedAt,
              lastError: null,
            }),
          },
        },
      },
    );

    await dbdCommand.execute(c);

    expect(replies[0]?.ephemeral).toBe(false);
    expect(titleOf(replies)).toBe(realT('dbd.stats.title', { name: 'SurvivorMain' }));
    const fields = fieldsOf(replies);
    expect(fields).toContainEqual({ name: 'Escapes', value: '12', inline: true });
    expect(fields).toContainEqual({ name: 'Generators repaired (equivalent)', value: '4.5', inline: true });
    const desc = descriptionOf(replies);
    expect(desc).toMatch(/<t:\d+:R>/);
    expect(desc).not.toContain('⚠️');
  });

  it('adds a stale-data note when the last refresh recorded an error', async () => {
    const { c, replies } = buildContext(
      { sub: 'stats' },
      {
        prismaOverrides: {
          gameAccountLink: { findUnique: async () => ({ id: 'l1', externalName: 'SurvivorMain' }) },
          gameStatSnapshot: {
            findUnique: async () => ({ stats: { escapes: 1 }, fetchedAt: new Date(), lastError: 'private' }),
          },
        },
      },
    );

    await dbdCommand.execute(c);

    expect(descriptionOf(replies)).toContain(
      realT('dbd.stats.staleNote', { reason: realT('dbd.stats.reason.private') }),
    );
  });
});

describe('/dbd leaderboard', () => {
  it('shows the empty placeholder and no pagination when nobody has linked yet', async () => {
    const { c, replies } = buildContext(
      { sub: 'leaderboard' },
      { prismaOverrides: { gameStatSnapshot: { findMany: async () => [] } } },
    );

    await dbdCommand.execute(c);

    expect(replies[0]?.ephemeral).toBe(false);
    expect(descriptionOf(replies)).toContain(realT('dbd.leaderboard.empty'));
    expect(replies[0]?.components).toHaveLength(0);
  });

  it('defaults to Escapes, ranks descending, and pages past 10 rows', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      userId: `user-${i}`,
      stats: { escapes: 100 - i },
    }));
    const { c, replies } = buildContext(
      { sub: 'leaderboard' },
      { prismaOverrides: { gameStatSnapshot: { findMany: async () => rows } } },
    );

    await dbdCommand.execute(c);

    expect(titleOf(replies)).toBe(realT('dbd.leaderboard.title', { stat: 'Escapes', page: 1, totalPages: 2 }));
    expect(descriptionOf(replies)).toContain(`**#1** <@user-0> — 100`);
    expect(descriptionOf(replies)).not.toContain('user-10'); // page 1 only shows the top 10
    expect(replies[0]?.components).toHaveLength(1);
  });

  it('ranks by the requested stat instead of the default', async () => {
    const rows = [
      { userId: 'a', stats: { escapes: 5, kills: 50 } },
      { userId: 'b', stats: { escapes: 10, kills: 20 } },
    ];
    const { c, replies } = buildContext(
      { sub: 'leaderboard', strings: { stat: 'kills' } },
      { prismaOverrides: { gameStatSnapshot: { findMany: async () => rows } } },
    );

    await dbdCommand.execute(c);

    expect(titleOf(replies)).toContain('Survivors killed (mori)');
    expect(descriptionOf(replies)).toContain('**#1** <@a> — 50');
  });
});

describe('/dbd refresh', () => {
  it('gives an ephemeral hint when the caller has not linked an account', async () => {
    const { c, replies } = buildContext(
      { sub: 'refresh' },
      { prismaOverrides: { gameAccountLink: { findUnique: async () => null } } },
    );

    await dbdCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('dbd.refresh.unlinked'));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('refreshes on the first call, then enforces a 60s per-user cooldown on the next', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: { DBD_Escape: 1 } });
    mocks.getPlayerSummary.mockResolvedValue(null);
    const link = { id: 'l1', guildId: GUILD_ID, userId: CALLER_ID, externalId: '123', externalName: null };
    const snapshotUpsert = vi.fn(async () => ({}));
    const { ctx } = createTestContext({
      prismaOverrides: {
        gameAccountLink: { findUnique: async () => link },
        gameStatSnapshot: { upsert: snapshotUpsert },
      },
    });
    const caller = makeUser(CALLER_ID, 'Caller');

    const first = fakeInteraction({ sub: 'refresh' }, caller);
    const c1: CommandContext = {
      interaction: first.interaction as unknown as ChatInputCommandInteraction<'cached'>,
      ctx,
      guildId: GUILD_ID,
      staffLevel: 'member',
      locale: 'en-US' as never,
      t: realT,
      config: async <T>() => ({}) as T,
    };
    await dbdCommand.execute(c1);
    expect(snapshotUpsert).toHaveBeenCalledTimes(1);
    expect(first.replies[0]?.ephemeral).toBe(true);
    expect(descriptionOf(first.replies)).toContain(realT('dbd.refresh.done'));

    const second = fakeInteraction({ sub: 'refresh' }, caller);
    const c2: CommandContext = { ...c1, interaction: second.interaction as unknown as ChatInputCommandInteraction<'cached'> };
    await dbdCommand.execute(c2);

    expect(snapshotUpsert).toHaveBeenCalledTimes(1); // not called again — blocked by the cooldown
    expect(descriptionOf(second.replies)).toContain('You can refresh again');
    expect(descriptionOf(second.replies)).toMatch(/<t:\d+:R>/);
  });

  it('surfaces a private-profile refresh failure distinctly', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: false, reason: 'private' });
    const link = { id: 'l1', guildId: GUILD_ID, userId: CALLER_ID, externalId: '123', externalName: null };
    const { c, replies } = buildContext(
      { sub: 'refresh' },
      {
        prismaOverrides: {
          gameAccountLink: { findUnique: async () => link },
          gameStatSnapshot: { upsert: async () => ({}) },
        },
      },
    );

    await dbdCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('dbd.refresh.private'));
  });

  it('surfaces a transient-hiccup refresh failure with its own distinct message', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: false, reason: 'transient' });
    const link = { id: 'l1', guildId: GUILD_ID, userId: CALLER_ID, externalId: '123', externalName: null };
    const { c, replies } = buildContext(
      { sub: 'refresh' },
      { prismaOverrides: { gameAccountLink: { findUnique: async () => link } } },
    );

    await dbdCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('dbd.refresh.transientError'));
  });

  it('bypasses the cache so a member forcing a refresh sees their current Steam state, not a stale hit', async () => {
    mocks.getGameStats.mockResolvedValue({ ok: true, stats: { DBD_Escape: 1 } });
    mocks.getPlayerSummary.mockResolvedValue(null);
    const link = { id: 'l1', guildId: GUILD_ID, userId: CALLER_ID, externalId: '123', externalName: null };
    const { c } = buildContext(
      { sub: 'refresh' },
      {
        prismaOverrides: {
          gameAccountLink: { findUnique: async () => link },
          gameStatSnapshot: { upsert: async () => ({}) },
        },
      },
    );

    await dbdCommand.execute(c);

    expect(mocks.getGameStats).toHaveBeenCalledWith(
      expect.anything(),
      link.externalId,
      expect.any(Number),
      expect.objectContaining({ bypassCache: true }),
    );
  });
});

describe('dbdComponents (leaderboard pagination)', () => {
  it('registers exactly one owner-only lb-page button handler', () => {
    expect(dbdComponents).toHaveLength(1);
    expect(dbdComponents[0]).toMatchObject({ action: 'lb-page', kind: 'button', ownerOnly: true });
  });

  it('re-queries the requested stat/page and updates the message in place', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ userId: `user-${i}`, stats: { kills: 100 - i } }));
    const { ctx } = createTestContext({ prismaOverrides: { gameStatSnapshot: { findMany: async () => rows } } });
    const update = vi.fn(async (_payload: { embeds: EmbedBuilder[]; components: unknown[] }) => undefined);
    const interaction = { user: makeUser(CALLER_ID, 'Caller'), update };

    const c: ComponentContext = {
      interaction: interaction as unknown as ButtonInteraction<'cached'>,
      ctx,
      guildId: GUILD_ID,
      staffLevel: 'member',
      locale: 'en-US' as never,
      t: realT,
      config: async <T>() => ({}) as T,
      args: [CALLER_ID, 'kills', '2'],
    };

    await dbdComponents[0]!.handler(c);

    expect(update).toHaveBeenCalledTimes(1);
    const payload = update.mock.calls[0]![0];
    expect(payload.embeds[0]!.data.title).toBe(
      realT('dbd.leaderboard.title', { stat: 'Survivors killed (mori)', page: 2, totalPages: 2 }),
    );
    expect(payload.components).toHaveLength(1);
  });
});
