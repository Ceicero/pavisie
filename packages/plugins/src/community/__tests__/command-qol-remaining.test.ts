import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChannelType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
} from 'discord.js';
import RedisMock from 'ioredis-mock';
import type { StaffLevel } from '@pavisie/types';
import { createTestContext, type RecordedPrismaCall } from '../../sdk/testing';
import type { CommandContext, PluginContext } from '../../sdk';
import { configSchema } from '../manifest';
import { command as birthdayCommand } from '../commands/birthday';
import { command as channelAutoCommand } from '../commands/channels';
import { command as statsCommand } from '../commands/statschannel';
import { command as stickyCommand } from '../commands/sticky';
import { command as tagCommand } from '../commands/tag';
import en from '../locales/en.json';

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

type OptValue = string | number | boolean | null;

beforeEach(async () => {
  await new RedisMock().flushall();
});

function replyText(replies: { embeds?: EmbedBuilder[] }[]): string {
  return replies[0]?.embeds?.[0]?.data.description ?? '';
}

function textChannel(id = 'ch1', permissions = true) {
  return {
    id,
    type: ChannelType.GuildText,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => permissions }),
    send: vi.fn(async () => ({ id: 'msg1' })),
    messages: { delete: vi.fn(async () => undefined) },
  };
}

function harness(opts: {
  sub: string;
  group?: string | null;
  strings?: Record<string, OptValue>;
  integers?: Record<string, number | null>;
  booleans?: Record<string, boolean | null>;
  channel?: {
    id: string;
    type?: number;
    permissionsFor?: (member: unknown) => { has: (perm: bigint) => boolean } | null;
  } | null;
  role?: { id: string; permissions?: { bitfield: bigint } } | null;
  guild?: unknown;
  config?: unknown;
  staffLevel?: StaffLevel;
  prismaOverrides?: Parameters<typeof createTestContext>[0] extends infer T
    ? T extends { prismaOverrides?: infer P }
      ? P
      : never
    : never;
  setConfig?: PluginContext['setConfig'];
  client?: PluginContext['client'];
  reply?: (payload: { embeds?: EmbedBuilder[]; ephemeral?: boolean }) => Promise<void>;
}) {
  const replies: { embeds?: EmbedBuilder[]; ephemeral?: boolean }[] = [];
  const edits: { embeds?: EmbedBuilder[] }[] = [];
  const modals: unknown[] = [];
  const setConfigs: unknown[] = [];
  const cfg = opts.config ?? configSchema.parse({});
  const { ctx, prismaCalls } = createTestContext({
    config: cfg,
    prismaOverrides: opts.prismaOverrides,
    overrides: {
      ...(opts.client ? { client: opts.client } : {}),
      setConfig:
        opts.setConfig ??
        (async <T>(_guildId: string, patch: Partial<T>) => {
          setConfigs.push(patch);
          return { ...(cfg as object), ...patch } as T;
        }),
    },
  });
  const strings = opts.strings ?? {};
  const integers = opts.integers ?? {};
  const booleans = opts.booleans ?? {};
  const interaction = {
    user: { id: 'user-1', username: 'ada', tag: 'ada' },
    guild: opts.guild ?? { id: 'guild-1', name: 'Test', memberCount: 3 },
    channelId: 'ch1',
    replied: false,
    deferred: false,
    options: {
      getSubcommand: () => opts.sub,
      getSubcommandGroup: (required?: boolean) => {
        if (required && !opts.group) throw new Error('missing group');
        return opts.group ?? null;
      },
      getString: (name: string, required?: boolean) => {
        if (!(name in strings)) {
          if (required) throw new Error(`missing string ${name}`);
          return null;
        }
        return strings[name];
      },
      getInteger: (name: string, required?: boolean) => {
        if (!(name in integers)) {
          if (required) throw new Error(`missing integer ${name}`);
          return null;
        }
        return integers[name];
      },
      getBoolean: (name: string) => (name in booleans ? booleans[name] : null),
      getChannel: (name: string, required?: boolean) => {
        if (name !== 'channel' || !opts.channel) {
          if (required) throw new Error(`missing channel ${name}`);
          return null;
        }
        return opts.channel;
      },
      getRole: () => opts.role ?? null,
      getUser: () => null,
    },
    reply: vi.fn(async (payload: { embeds?: EmbedBuilder[]; ephemeral?: boolean }) => {
      if (opts.reply) return opts.reply(payload);
      replies.push(payload);
    }),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async (payload: { embeds?: EmbedBuilder[] }) => {
      edits.push(payload);
    }),
    showModal: vi.fn(async (modal: unknown) => {
      modals.push(modal);
    }),
  };
  const c: CommandContext = {
    interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
    ctx,
    guildId: 'guild-1',
    staffLevel: opts.staffLevel ?? 'admin',
    locale: 'en-US' as never,
    t: realT,
    config: async <T>() => cfg as T,
  };
  return { c, replies, edits, modals, setConfigs, prismaCalls, interaction };
}

function saved(calls: unknown[]): boolean {
  return calls.length > 0;
}

function wrote(calls: RecordedPrismaCall[], model: string, method: string): boolean {
  return calls.some((call) => call.model === model && call.method === method);
}

describe('birthday command quality of life', () => {
  const liveGuild = () => ({
    id: 'guild-1',
    name: 'Test',
    memberCount: 3,
    channels: { fetch: async (id: string) => (id === 'ch1' ? textChannel() : null) },
    members: { me: { id: 'bot', roles: { highest: { position: 5 } } } },
    roles: { cache: { get: () => undefined }, fetch: async () => null },
  });

  it('rejects a blank announcement and keeps admin config replies ephemeral', async () => {
    const blank = harness({
      sub: 'config',
      strings: { message: '   ' },
      channel: { id: 'ch1' },
      guild: liveGuild(),
      config: configSchema.parse({ birthdays: { enabled: true } }),
    });
    await birthdayCommand.execute(blank.c);
    expect(replyText(blank.replies)).toContain(realT('birthday.emptyMessage'));
    expect(blank.replies[0]?.ephemeral).toBe(true);
    expect(saved(blank.setConfigs)).toBe(false);

    const trimmed = harness({
      sub: 'config',
      strings: { message: '  hello {mention}  ' },
      channel: { id: 'ch1' },
      guild: liveGuild(),
      config: configSchema.parse({ birthdays: { enabled: true } }),
    });
    await birthdayCommand.execute(trimmed.c);
    expect(trimmed.replies[0]?.ephemeral).toBe(true);
    expect(trimmed.setConfigs[0]).toMatchObject({
      birthdays: { message: 'hello {mention}', channelId: 'ch1' },
    });
  });

  it('distinguishes a deleted birthday channel from one the bot cannot post in', async () => {
    const gone = harness({
      sub: 'config',
      channel: { id: 'ch1' },
      guild: {
        ...liveGuild(),
        channels: {
          fetch: async () => {
            throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
          },
        },
      },
    });
    await birthdayCommand.execute(gone.c);
    expect(replyText(gone.replies)).toContain(realT('birthday.channelGone'));
    expect(gone.replies[0]?.ephemeral).toBe(true);
    expect(saved(gone.setConfigs)).toBe(false);

    const blocked = harness({
      sub: 'config',
      channel: { id: 'ch1' },
      guild: {
        ...liveGuild(),
        channels: { fetch: async () => textChannel('ch1', false) },
      },
    });
    await birthdayCommand.execute(blocked.c);
    expect(replyText(blocked.replies)).toContain(realT('birthday.badChannel'));
    expect(saved(blocked.setConfigs)).toBe(false);
  });

  it('explains a deleted birthday role and a failed save', async () => {
    const role = harness({
      sub: 'config',
      channel: { id: 'ch1' },
      role: { id: 'role-1', permissions: { bitfield: 0n } },
      guild: liveGuild(),
    });
    await birthdayCommand.execute(role.c);
    expect(replyText(role.replies)).toContain(realT('birthday.role.missing'));
    expect(role.replies[0]?.ephemeral).toBe(true);
    expect(saved(role.setConfigs)).toBe(false);

    const failed = harness({
      sub: 'config',
      channel: { id: 'ch1' },
      guild: liveGuild(),
      setConfig: async () => {
        throw new Error('db down');
      },
    });
    await birthdayCommand.execute(failed.c);
    expect(replyText(failed.replies)).toContain(realT('birthday.saveFailed'));
    expect(failed.replies[0]?.ephemeral).toBe(true);
  });

  it('uses a helpful empty state for /birthday upcoming and keeps it private for members', async () => {
    const member = harness({
      sub: 'upcoming',
      booleans: { ephemeral: false },
      staffLevel: 'member',
      config: configSchema.parse({}),
    });
    await birthdayCommand.execute(member.c);
    expect(replyText(member.replies)).toContain(realT('birthday.upcomingEmpty'));
    expect(member.replies[0]?.ephemeral).toBe(true);
  });

  it('says when the configured announcement channel was deleted', async () => {
    const viewed = harness({
      sub: 'config-view',
      staffLevel: 'moderator',
      config: configSchema.parse({ birthdays: { channelId: 'missing', enabled: true } }),
      guild: {
        id: 'guild-1',
        channels: {
          fetch: async () => {
            throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
          },
        },
        roles: { cache: { get: () => undefined } },
      },
    });
    await birthdayCommand.execute(viewed.c);
    expect(replyText(viewed.replies)).toContain(realT('birthday.channelMissing'));
    expect(viewed.replies[0]?.ephemeral).toBe(true);
  });
});

describe('tag command quality of life', () => {
  const enabled = configSchema.parse({ tags: { enabled: true, triggersEnabled: true } });
  const tagRow = {
    id: 'tag1',
    guildId: 'guild-1',
    name: 'rules',
    content: 'Read the rules',
    embed: null,
    triggerMode: 'NONE',
    trigger: null,
    triggerChannelIds: [] as string[],
    staffOnly: false,
    uses: 0,
    createdBy: 'staff1',
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('replies ephemerally when tags are turned off', async () => {
    const { c, replies } = harness({
      sub: 'show',
      strings: { name: 'rules' },
      config: configSchema.parse({ tags: { enabled: false } }),
      staffLevel: 'member',
    });
    await expect(tagCommand.execute(c)).resolves.toBeUndefined();
    expect(replyText(replies)).toContain(realT('tag.disabled'));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('opens the editor for blank content and stores trimmed content', async () => {
    const blank = harness({
      sub: 'create',
      strings: { name: 'Rules', content: '   ' },
      staffLevel: 'moderator',
      config: enabled,
    });
    await tagCommand.execute(blank.c);
    expect(blank.modals).toHaveLength(1);
    expect(wrote(blank.prismaCalls, 'tag', 'create')).toBe(false);

    const created: unknown[] = [];
    const trimmed = harness({
      sub: 'create',
      strings: { name: 'Rules', content: '  Be kind  ' },
      staffLevel: 'moderator',
      config: enabled,
      prismaOverrides: {
        tag: {
          create: async (args: unknown) => {
            created.push(args);
            return { id: 'tag1' };
          },
        },
      },
    });
    await tagCommand.execute(trimmed.c);
    expect(created[0]).toMatchObject({ data: { name: 'rules', content: 'Be kind' } });
    expect(trimmed.replies[0]?.ephemeral).toBe(true);
  });

  it('rejects an empty trigger phrase and a deleted or unusable trigger channel', async () => {
    const empty = harness({
      sub: 'trigger',
      strings: { name: 'rules', mode: 'CONTAINS', phrase: '   ' },
      config: enabled,
      prismaOverrides: { tag: { findUnique: async () => tagRow } },
    });
    await tagCommand.execute(empty.c);
    expect(replyText(empty.replies)).toContain(realT('tag.emptyTrigger'));
    expect(empty.replies[0]?.ephemeral).toBe(true);
    expect(wrote(empty.prismaCalls, 'tag', 'update')).toBe(false);

    const gone = harness({
      sub: 'trigger',
      strings: { name: 'rules', mode: 'CONTAINS', phrase: 'hello there' },
      channel: { id: 'ch1' },
      config: enabled,
      guild: {
        id: 'guild-1',
        channels: {
          fetch: async () => {
            throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
          },
        },
      },
      prismaOverrides: { tag: { findUnique: async () => tagRow } },
    });
    await tagCommand.execute(gone.c);
    expect(replyText(gone.replies)).toContain(realT('tag.channelGone'));
    expect(wrote(gone.prismaCalls, 'tag', 'update')).toBe(false);

    const blocked = harness({
      sub: 'trigger',
      strings: { name: 'rules', mode: 'CONTAINS', phrase: 'hello there' },
      channel: { id: 'ch1' },
      config: enabled,
      guild: {
        id: 'guild-1',
        channels: { fetch: async () => textChannel('ch1', false) },
        members: { me: { id: 'bot' } },
      },
      prismaOverrides: { tag: { findUnique: async () => tagRow } },
    });
    await tagCommand.execute(blocked.c);
    expect(replyText(blocked.replies)).toContain(realT('tag.badChannel'));
    expect(blocked.replies[0]?.ephemeral).toBe(true);
    expect(wrote(blocked.prismaCalls, 'tag', 'update')).toBe(false);
  });

  it('explains a failed public post and does not count a use', async () => {
    let attempts = 0;
    const shown = harness({
      sub: 'show',
      strings: { name: 'rules' },
      staffLevel: 'member',
      config: enabled,
      guild: { id: 'guild-1', name: 'Test', memberCount: 3 },
      prismaOverrides: { tag: { findUnique: async () => tagRow, update: async () => tagRow } },
      reply: async (payload) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
        shownReplies.push(payload);
      },
    });
    const shownReplies: { embeds?: EmbedBuilder[]; ephemeral?: boolean }[] = [];
    await tagCommand.execute(shown.c);
    expect(replyText(shownReplies)).toContain(realT('tag.cantPost'));
    expect(shownReplies[0]?.ephemeral).toBe(true);
    expect(wrote(shown.prismaCalls, 'tag', 'update')).toBe(false);
  });
});

describe('sticky command quality of life', () => {
  function stickyGuild(send: () => Promise<unknown>) {
    const channel = textChannel();
    channel.send = vi.fn(send);
    return {
      guild: {
        id: 'guild-1',
        name: 'Test',
        channels: { fetch: async (id: string) => (id === 'ch1' ? channel : null) },
        members: { me: { id: 'bot' } },
      },
      channel,
    };
  }

  it('rejects whitespace content and opens the editor when content is omitted', async () => {
    const { guild } = stickyGuild(async () => ({ id: 'msg1' }));
    const blank = harness({
      sub: 'set',
      strings: { content: '   ' },
      channel: { id: 'ch1' },
      guild,
      config: configSchema.parse({}),
    });
    await stickyCommand.execute(blank.c);
    expect(replyText(blank.replies)).toContain(realT('sticky.empty'));
    expect(blank.replies[0]?.ephemeral).toBe(true);
    expect(blank.interaction.deferReply).not.toHaveBeenCalled();
    expect(wrote(blank.prismaCalls, 'stickyMessage', 'upsert')).toBe(false);

    const modal = harness({
      sub: 'set',
      channel: { id: 'ch1' },
      guild,
      config: configSchema.parse({}),
    });
    await stickyCommand.execute(modal.c);
    expect(modal.modals).toHaveLength(1);
    expect(wrote(modal.prismaCalls, 'stickyMessage', 'upsert')).toBe(false);
  });

  it('explains a failed first post instead of claiming the sticky was posted', async () => {
    const { guild } = stickyGuild(async () => {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    });
    let finds = 0;
    const row = {
      id: 'sticky1',
      guildId: 'guild-1',
      channelId: 'ch1',
      content: 'hello',
      embed: null,
      cooldownSeconds: 10,
      lastMessageId: null as string | null,
      lastPostedAt: null,
      createdBy: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { c, edits, interaction } = harness({
      sub: 'set',
      strings: { content: 'hello' },
      channel: { id: 'ch1' },
      guild,
      config: configSchema.parse({}),
      prismaOverrides: {
        stickyMessage: {
          findUnique: async () => {
            finds += 1;
            return finds === 1 ? null : row;
          },
          count: async () => 0,
          upsert: async () => row,
        },
      },
    });
    await stickyCommand.execute(c);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(replyText(edits)).toContain(realT('sticky.postFailed'));
  });

  it('still removes a sticky when its message was already deleted', async () => {
    const { guild, channel } = stickyGuild(async () => ({ id: 'msg1' }));
    channel.messages.delete = vi.fn(async () => {
      throw Object.assign(new Error('Unknown Message'), { code: 10008 });
    });
    const row = {
      id: 'sticky1',
      guildId: 'guild-1',
      channelId: 'ch1',
      content: 'hello',
      embed: null,
      cooldownSeconds: 10,
      lastMessageId: 'old-msg',
      createdBy: 'user-1',
    };
    const { c, edits, interaction } = harness({
      sub: 'remove',
      channel: { id: 'ch1' },
      guild,
      config: configSchema.parse({}),
      client: { guilds: { fetch: async () => guild } } as unknown as PluginContext['client'],
      prismaOverrides: {
        stickyMessage: {
          findUnique: async () => row,
          delete: async () => row,
        },
      },
    });
    await stickyCommand.execute(c);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(replyText(edits)).toContain('Sticky message removed');
    expect(channel.messages.delete).toHaveBeenCalledWith('old-msg');
  });

  it('drops stickies whose channels were deleted and says so', async () => {
    const { c, replies, prismaCalls } = harness({
      sub: 'list',
      guild: {
        id: 'guild-1',
        channels: { fetch: async () => null },
      },
      prismaOverrides: {
        stickyMessage: {
          findMany: async () => [
            { channelId: 'gone', content: 'hi', embed: null, lastPostedAt: null, lastMessageId: null },
          ],
          deleteMany: async () => ({ count: 1 }),
        },
      },
    });
    await stickyCommand.execute(c);
    expect(replyText(replies)).toContain(realT('sticky.pruned', { count: 1 }));
    expect(replies[0]?.ephemeral).toBe(true);
    expect(wrote(prismaCalls, 'stickyMessage', 'deleteMany')).toBe(true);
  });
});

describe('channel automation command quality of life', () => {
  const announcement = {
    id: 'ann1',
    type: ChannelType.GuildAnnouncement,
    permissionsFor: () => ({ has: (perm: bigint) => perm !== PermissionFlagsBits.ViewChannel }),
  };

  it('refuses an announcement channel the bot cannot see', async () => {
    const { c, replies, setConfigs } = harness({
      group: 'publish',
      sub: 'add',
      channel: announcement,
      guild: { id: 'guild-1', members: { me: { id: 'bot' } } },
    });
    await channelAutoCommand.execute(c);
    expect(replyText(replies)).toContain('Grant me View Channel');
    expect(replies[0]?.ephemeral).toBe(true);
    expect(saved(setConfigs)).toBe(false);
  });

  it('still saves auto-publish when Manage Messages is missing, and says so', async () => {
    const { c, replies, setConfigs } = harness({
      group: 'publish',
      sub: 'add',
      channel: {
        id: 'ann1',
        type: ChannelType.GuildAnnouncement,
        permissionsFor: () => ({ has: (perm: bigint) => perm !== PermissionFlagsBits.ManageMessages }),
      },
      guild: { id: 'guild-1', members: { me: { id: 'bot' } } },
    });
    await channelAutoCommand.execute(c);
    expect(saved(setConfigs)).toBe(true);
    expect(replyText(replies)).toContain('Manage Messages');
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('rejects a blank thread name or starter and notes unknown tokens', async () => {
    const channel = { id: 'ch1', type: ChannelType.GuildText };
    const guild = { id: 'guild-1', members: { me: { id: 'bot' } } };
    const blankName = harness({
      group: 'thread',
      sub: 'add',
      channel,
      guild,
      strings: { name: '   ' },
    });
    await channelAutoCommand.execute(blankName.c);
    expect(replyText(blankName.replies)).toContain(realT('channelauto.thread.emptyName'));
    expect(saved(blankName.setConfigs)).toBe(false);

    const blankStarter = harness({
      group: 'thread',
      sub: 'add',
      channel,
      guild,
      strings: { starter: '   ' },
    });
    await channelAutoCommand.execute(blankStarter.c);
    expect(replyText(blankStarter.replies)).toContain(realT('channelauto.thread.emptyStarter'));
    expect(saved(blankStarter.setConfigs)).toBe(false);

    const unknown = harness({
      group: 'thread',
      sub: 'add',
      channel,
      guild,
      strings: { name: '{user} {nope}' },
    });
    await channelAutoCommand.execute(unknown.c);
    expect(saved(unknown.setConfigs)).toBe(true);
    expect(replyText(unknown.replies)).toContain('{nope}');
    expect(unknown.replies[0]?.ephemeral).toBe(true);
  });

  it('warns when the bot cannot create threads, and drops deleted channels from the list', async () => {
    const warned = harness({
      group: 'thread',
      sub: 'add',
      channel: {
        id: 'ch1',
        type: ChannelType.GuildText,
        permissionsFor: () => ({ has: (perm: bigint) => perm !== PermissionFlagsBits.CreatePublicThreads }),
      },
      guild: { id: 'guild-1', members: { me: { id: 'bot' } } },
    });
    await channelAutoCommand.execute(warned.c);
    expect(saved(warned.setConfigs)).toBe(true);
    expect(replyText(warned.replies)).toContain('Create Public Threads');

    const listed = harness({
      group: 'publish',
      sub: 'list',
      config: configSchema.parse({ autoPublish: { channelIds: ['old'] } }),
      guild: {
        id: 'guild-1',
        channels: {
          fetch: async () => {
            throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
          },
        },
      },
    });
    await channelAutoCommand.execute(listed.c);
    expect(replyText(listed.replies)).toContain(realT('channelauto.pruned', { count: 1 }));
    expect(listed.replies[0]?.ephemeral).toBe(true);
    expect(listed.setConfigs[0]).toMatchObject({ autoPublish: { channelIds: [] } });
  });
});

describe('stats channel command quality of life', () => {
  it('rejects a blank template and explains a missing Manage Channels error', async () => {
    const blank = harness({
      sub: 'create',
      strings: { template: '   ' },
      guild: {
        id: 'guild-1',
        channels: { create: vi.fn() },
        roles: { everyone: { id: 'guild-1' } },
      },
    });
    await statsCommand.execute(blank.c);
    expect(replyText(blank.replies)).toContain(realT('statschannel.emptyTemplate'));
    expect(blank.replies[0]?.ephemeral).toBe(true);
    expect(saved(blank.setConfigs)).toBe(false);

    const denied = harness({
      sub: 'create',
      strings: { template: 'Members: {members}' },
      guild: {
        id: 'guild-1',
        memberCount: 4,
        members: { cache: { filter: () => ({ size: 0 }) } },
        premiumSubscriptionCount: 0,
        roles: { cache: { size: 1 }, everyone: { id: 'guild-1' } },
        channels: {
          cache: { size: 1 },
          create: async () => {
            throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
          },
        },
      },
    });
    await statsCommand.execute(denied.c);
    expect(replyText(denied.replies)).toContain('Manage Channels');
    expect(saved(denied.setConfigs)).toBe(false);

    const other = harness({
      sub: 'create',
      strings: { template: 'Members: {members}' },
      guild: {
        id: 'guild-1',
        memberCount: 4,
        members: { cache: { filter: () => ({ size: 0 }) } },
        premiumSubscriptionCount: 0,
        roles: { cache: { size: 1 }, everyone: { id: 'guild-1' } },
        channels: {
          cache: { size: 1 },
          create: async () => {
            throw new Error('nope');
          },
        },
      },
    });
    await statsCommand.execute(other.c);
    expect(replyText(other.replies)).toContain(realT('statschannel.createFailedOther'));
  });

  it('deletes the new channel when saving it fails', async () => {
    const deleted = vi.fn(async () => undefined);
    const { c, replies } = harness({
      sub: 'create',
      strings: { template: 'Members: {members}' },
      guild: {
        id: 'guild-1',
        memberCount: 4,
        members: { cache: { filter: () => ({ size: 0 }) } },
        premiumSubscriptionCount: 0,
        roles: { cache: { size: 1 }, everyone: { id: 'guild-1' } },
        channels: {
          cache: { size: 1 },
          create: async () => ({ id: 'new-channel', delete: deleted }),
        },
      },
      setConfig: async () => {
        throw new Error('db down');
      },
    });
    await statsCommand.execute(c);
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(replyText(replies)).toContain(realT('statschannel.saveFailed'));
    expect(replies[0]?.ephemeral).toBe(true);
  });

  it('uses a helpful empty state for list and refresh', async () => {
    const listed = harness({ sub: 'list', guild: { id: 'guild-1' } });
    await statsCommand.execute(listed.c);
    expect(replyText(listed.replies)).toContain(realT('statschannel.listEmpty'));
    expect(listed.replies[0]?.ephemeral).toBe(true);

    const refreshed = harness({ sub: 'refresh', guild: { id: 'guild-1' } });
    await statsCommand.execute(refreshed.c);
    expect(replyText(refreshed.replies)).toContain(realT('statschannel.listEmpty'));
    expect(refreshed.replies[0]?.ephemeral).toBe(true);
  });

  it('refuses a deleted channel or one the bot cannot rename', async () => {
    const gone = harness({
      sub: 'add',
      strings: { template: 'Members: {members}' },
      channel: { id: 'ch1' },
      guild: {
        id: 'guild-1',
        channels: {
          fetch: async () => {
            throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
          },
        },
      },
    });
    await statsCommand.execute(gone.c);
    expect(replyText(gone.replies)).toContain(realT('statschannel.channelGone'));
    expect(saved(gone.setConfigs)).toBe(false);

    const blocked = harness({
      sub: 'add',
      strings: { template: 'Members: {members}' },
      channel: {
        id: 'ch1',
        permissionsFor: () => ({ has: () => false }),
      },
      guild: { id: 'guild-1', members: { me: { id: 'bot' } } },
    });
    await statsCommand.execute(blocked.c);
    expect(replyText(blocked.replies)).toContain(realT('statschannel.cantManage', { channel: '<#ch1>' }));
    expect(blocked.replies[0]?.ephemeral).toBe(true);
    expect(saved(blocked.setConfigs)).toBe(false);
  });

  it('points at a deleted counter instead of pretending it still renders', async () => {
    const { c, replies } = harness({
      sub: 'list',
      config: configSchema.parse({ statsChannels: [{ channelId: 'gone', template: 'Members: {members}' }] }),
      guild: {
        id: 'guild-1',
        memberCount: 4,
        members: { cache: { filter: () => ({ size: 0 }) } },
        premiumSubscriptionCount: 0,
        roles: { cache: { size: 1 } },
        channels: {
          cache: { size: 1 },
          fetch: async () => {
            throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
          },
        },
      },
    });
    await statsCommand.execute(c);
    expect(replyText(replies)).toContain('was deleted');
    expect(replies[0]?.ephemeral).toBe(true);
  });
});
