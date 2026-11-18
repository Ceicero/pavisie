import { Buffer } from 'node:buffer';
import { PermissionFlagsBits, PermissionsBitField, type EmbedBuilder } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { command as levelCommand } from '../commands/level';
import { configSchema } from '../manifest';
import en from '../locales/en.json';
import { renderRankCard, type RankCardInput } from '../rank-card';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 1×1 PNG. Enough for satori to embed an avatar without a network fetch. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function expectPng(bytes: Uint8Array): void {
  expect(bytes.byteLength).toBeGreaterThan(32);
  expect(Buffer.from(bytes.subarray(0, 8))).toEqual(PNG_SIGNATURE);
}

describe('rank card png', () => {
  const cases: { name: string; input: RankCardInput }[] = [
    {
      name: 'a normal card with an avatar',
      input: {
        displayName: 'Ada Lovelace',
        rank: 4,
        xp: 1_250,
        avatar: TINY_PNG,
      },
    },
    {
      name: 'level 0',
      input: { displayName: 'New member', rank: 1, xp: 0, avatar: null },
    },
    {
      name: 'a very large XP total',
      input: { displayName: 'Veteran', rank: 1, xp: 1_000_000_000, avatar: null },
    },
    {
      name: 'a long unicode name and no usable avatar bytes',
      input: {
        displayName: 'Юлия Ñandú — café ✨ '.repeat(8) + '名前',
        rank: 42,
        xp: 8_888,
        avatar: new Uint8Array([1, 2, 3, 4]),
      },
    },
    {
      name: 'a missing avatar',
      input: { displayName: 'No portrait', rank: 9, xp: 400, avatar: null },
    },
  ];

  it.each(cases)('renders a non-empty PNG for $name', async ({ input }) => {
    const png = await renderRankCard(input);
    expectPng(png);
  });

  it('changes the image when an avatar is present', async () => {
    const shared = { displayName: 'Ada Lovelace', rank: 4, xp: 1_250 };
    const withAvatar = await renderRankCard({ ...shared, avatar: TINY_PNG });
    const withoutAvatar = await renderRankCard({ ...shared, avatar: null });
    expectPng(withAvatar);
    expectPng(withoutAvatar);
    expect(Buffer.compare(Buffer.from(withAvatar), Buffer.from(withoutAvatar))).not.toBe(0);
  });
});

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
    for (const [name, value] of Object.entries(vars)) {
      out = out.replaceAll(`{${name}}`, String(value));
    }
  }
  return out;
}

interface RankReply {
  embeds?: EmbedBuilder[];
  files?: { name?: string }[];
  ephemeral?: boolean;
}

function rankContext(opts: { attach: boolean; userId?: string }): {
  commandContext: CommandContext;
  replies: RankReply[];
  warn: ReturnType<typeof vi.fn>;
} {
  const replies: RankReply[] = [];
  const warn = vi.fn();
  const userId = opts.userId ?? 'user-1';
  const user = {
    id: userId,
    username: 'ada',
    displayName: 'Ada Lovelace',
    displayAvatarURL: () => {
      throw new Error('avatar unavailable in this test');
    },
  };
  const interaction = {
    user,
    replied: false,
    deferred: false,
    member: { id: userId, displayName: 'Ada Lovelace' },
    guild: { id: 'guild-1', members: { me: { id: 'bot-1' } } },
    channel: null,
    appPermissions: new PermissionsBitField(opts.attach ? PermissionFlagsBits.AttachFiles : 0n),
    options: {
      getSubcommand: () => 'rank',
      getSubcommandGroup: () => null,
      getUser: () => user,
      getMember: () => null,
      getString: () => null,
      getChannel: () => null,
      getInteger: () => null,
      getRole: () => null,
      getNumber: () => null,
    },
    reply: vi.fn(async (payload: RankReply) => {
      replies.push(payload);
    }),
  };

  const { ctx } = createTestContext({
    config: configSchema.parse({}),
    prismaOverrides: {
      levelProfile: {
        findUnique: async () => ({
          id: 'profile-1',
          guildId: 'guild-1',
          userId,
          xp: 500,
          level: 3,
          messages: 12,
          voiceMinutes: 4,
        }),
        count: async () => 2,
      },
    },
    overrides: {
      logger: { warn } as unknown as CommandContext['ctx']['logger'],
    },
  });

  const commandContext = {
    interaction,
    ctx,
    guildId: 'guild-1',
    staffLevel: 'member',
    locale: 'en',
    t: realT,
    config: async () => configSchema.parse({}),
  } as unknown as CommandContext;

  return { commandContext, replies, warn };
}

describe('/level rank fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the text rank when the renderer throws', async () => {
    const rankCard = await import('../rank-card');
    vi.spyOn(rankCard, 'renderRankCard').mockRejectedValue(new Error('render boom'));
    const { commandContext, replies, warn } = rankContext({ attach: true });

    await levelCommand.execute(commandContext);
    await levelCommand.execute(commandContext);

    expect(replies).toHaveLength(2);
    expect(replies.every((reply) => reply.files === undefined)).toBe(true);
    expect(replies[0]?.embeds?.[0]?.data.title).toBe("ada's rank");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sends the text rank when Attach Files is missing in the channel', async () => {
    const rankCard = await import('../rank-card');
    const render = vi.spyOn(rankCard, 'renderRankCard');
    const { commandContext, replies, warn } = rankContext({ attach: false });

    await levelCommand.execute(commandContext);
    await levelCommand.execute(commandContext);

    expect(render).not.toHaveBeenCalled();
    expect(replies).toHaveLength(2);
    expect(replies.every((reply) => reply.files === undefined)).toBe(true);
    expect(replies[0]?.embeds?.[0]?.data.title).toBe("ada's rank");
    expect(String(replies[0]?.embeds?.[0]?.data.fields?.map((field) => field.value).join('\n'))).toContain(
      '#3',
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
