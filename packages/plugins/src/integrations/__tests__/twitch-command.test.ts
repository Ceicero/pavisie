import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { env } from '@pavisie/core';
import * as crypto from '@pavisie/core';
import { createTestContext } from '../../sdk/testing';
import type { CommandContext, ServiceRegistry } from '../../sdk';
import { command as twitchCommand, twitchConfirmComponents } from '../commands/twitch';
import en from '../locales/en.json';

/** Looks a dotted key up in the plugin's real `en.json` with `{var}` interpolation (same stand-in used by
 * community/__tests__/tag-command.test.ts and moderation/__tests__/purge-command.test.ts). */
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
const USER_ID = '111111111111111111';

const CHANNEL_1 = {
  id: 'chan1',
  guildId: GUILD_ID,
  broadcasterUserId: 'twitch-uid-1',
  broadcasterLogin: 'streamer_one',
  enabled: true,
  status: 'CONNECTED',
  lastError: null as string | null,
  lastConnectedAt: null as Date | null,
  commandPrefix: '!',
  connectionId: null as string | null,
  overlayTokenEnc: null as string | null,
  rewardsEnabled: false,
  createdBy: USER_ID,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const CHANNEL_2 = {
  ...CHANNEL_1,
  id: 'chan2',
  broadcasterUserId: 'twitch-uid-2',
  broadcasterLogin: 'streamer_two',
};

interface ReplyPayload {
  embeds?: EmbedBuilder[];
  components?: unknown[];
  ephemeral?: boolean;
}

interface FakeOptions {
  group?: string | null;
  sub: string;
  strings?: Record<string, string | null>;
  integers?: Record<string, number | null>;
  channels?: Record<string, { id: string } | null>;
  focused?: { name: string; value: string };
}

function fakeInteraction(opts: FakeOptions) {
  const replies: ReplyPayload[] = [];
  const followUps: ReplyPayload[] = [];

  const interaction = {
    user: { id: USER_ID },
    guild: { id: GUILD_ID },
    options: {
      getSubcommandGroup: () => opts.group ?? null,
      getSubcommand: () => opts.sub,
      getString: (name: string) => (opts.strings ?? {})[name] ?? null,
      getInteger: (name: string) => (opts.integers ?? {})[name] ?? null,
      getChannel: (name: string) => (opts.channels ?? {})[name] ?? null,
      getFocused: () => opts.focused ?? { name: 'channel', value: '' },
    },
    reply: vi.fn(async (payload: ReplyPayload) => {
      replies.push(payload);
    }),
    followUp: vi.fn(async (payload: ReplyPayload) => {
      followUps.push(payload);
    }),
    respond: vi.fn(async () => undefined),
  };

  return { interaction, replies, followUps };
}

function buildContext(
  opts: FakeOptions,
  testCtxOverrides: Parameters<typeof createTestContext>[0] = {},
): { c: CommandContext; replies: ReplyPayload[]; followUps: ReplyPayload[]; services: ServiceRegistry } {
  const { interaction, replies, followUps } = fakeInteraction(opts);
  const { ctx, services } = createTestContext(testCtxOverrides);

  const c: CommandContext = {
    interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
    ctx,
    guildId: GUILD_ID,
    staffLevel: 'admin',
    locale: 'en-US' as never,
    t: realT,
    config: async <T>() => ({}) as T,
  };

  return { c, replies, followUps, services };
}

function descriptionOf(payloads: ReplyPayload[]): string {
  return payloads[0]?.embeds?.[0]?.data.description ?? '';
}

describe('/twitch status', () => {
  it('reports no bot identity and no channels honestly', async () => {
    const { c, replies } = buildContext(
      { sub: 'status' },
      {
        prismaOverrides: {
          twitchBotIdentity: { findFirst: async () => null },
          twitchChatChannel: { findMany: async () => [] },
        },
      },
    );

    await twitchCommand.execute(c);

    const desc = descriptionOf(replies);
    expect(desc).toContain(realT('twitch.status.botNotConfigured'));
    expect(desc).toContain(realT('twitch.status.noChannels'));
  });

  it('shows the bot login and per-channel command/timer counts when configured', async () => {
    const { c, replies } = buildContext(
      { sub: 'status' },
      {
        prismaOverrides: {
          twitchBotIdentity: { findFirst: async () => ({ botLogin: 'pavisie_bot' }) },
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatCommand: { count: async () => 3 },
          twitchChatTimer: { count: async () => 1 },
        },
      },
    );

    await twitchCommand.execute(c);

    const desc = descriptionOf(replies);
    expect(desc).toContain(realT('twitch.status.botConfigured', { login: 'pavisie_bot' }));
    expect(desc).toContain(
      realT('twitch.status.channelLine', {
        status: '🟢 Connected',
        login: 'streamer_one',
        prefix: '!',
        commands: 3,
        timers: 1,
        disabled: '',
      }),
    );
  });
});

describe('/twitch setup', () => {
  it('includes the dashboard click-path and a caveat when the bot identity is missing', async () => {
    const { c, replies } = buildContext(
      { sub: 'setup' },
      { prismaOverrides: { twitchBotIdentity: { findFirst: async () => null } } },
    );

    await twitchCommand.execute(c);

    const url = `${env.DASHBOARD_URL ?? 'the dashboard'}/dashboard/${GUILD_ID}/integrations`;
    const desc = descriptionOf(replies);
    expect(desc).toContain(realT('twitch.setup.instructions', { url }));
    expect(desc).toContain(realT('twitch.setup.botNotConfiguredNote'));
  });

  it('omits the caveat once the bot identity is connected', async () => {
    const { c, replies } = buildContext(
      { sub: 'setup' },
      { prismaOverrides: { twitchBotIdentity: { findFirst: async () => ({ botLogin: 'pavisie_bot' }) } } },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).not.toContain('ask the bot owner');
  });
});

describe('/twitch off', () => {
  it('refuses when the guild has no linked channels', async () => {
    const { c, replies } = buildContext(
      { sub: 'off' },
      { prismaOverrides: { twitchChatChannel: { findMany: async () => [] } } },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.off.noChannels'));
  });

  it('sends a confirmation prompt (and disables nothing yet) when fast actions are off', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const { c, replies } = buildContext(
      { sub: 'off' },
      {
        prismaOverrides: { twitchChatChannel: { findMany: async () => [CHANNEL_1], updateMany } },
      },
    );
    c.ctx.services.register('host', { getGuildConfig: async () => ({ fastActions: false }) } as never);

    await twitchCommand.execute(c);

    expect(updateMany).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]?.components).toHaveLength(1);
  });

  it('disables every channel, audits, and nudges reconcile when fast actions short-circuit the prompt', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const audit = vi.fn(async () => undefined);
    const reconcileNow = vi.fn(async () => undefined);
    const { c, replies } = buildContext(
      { sub: 'off' },
      {
        prismaOverrides: { twitchChatChannel: { findMany: async () => [CHANNEL_1], updateMany } },
        overrides: { audit },
      },
    );
    c.ctx.services.register('host', { getGuildConfig: async () => ({ fastActions: true }) } as never);
    c.ctx.services.register(
      'twitchChat',
      { status: () => undefined, reconcileNow, stop: async () => undefined } as never,
    );

    await twitchCommand.execute(c);

    expect(updateMany).toHaveBeenCalledWith({ where: { guildId: GUILD_ID }, data: { enabled: false } });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(reconcileNow).toHaveBeenCalledTimes(1);
    expect(descriptionOf(replies)).toContain(realT('twitch.off.done'));
  });
});

describe('/twitch command add — validation', () => {
  it('rejects an invalid name without touching the database', async () => {
    const findMany = vi.fn(async () => [CHANNEL_1]);
    const { c, replies } = buildContext(
      { group: 'command', sub: 'add', strings: { name: 'Not Valid!', response: 'hi' } },
      { prismaOverrides: { twitchChatChannel: { findMany } } },
    );

    await twitchCommand.execute(c);

    expect(findMany).not.toHaveBeenCalled();
    expect(descriptionOf(replies)).toContain(realT('twitch.errors.invalidName'));
  });

  it('rejects a reserved built-in command name', async () => {
    const { c, replies } = buildContext({
      group: 'command',
      sub: 'add',
      strings: { name: 'uptime', response: 'hi' },
    });

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.errors.reservedName', { name: 'uptime' }));
  });

  it('rejects a response that is only whitespace', async () => {
    const { c, replies } = buildContext({
      group: 'command',
      sub: 'add',
      strings: { name: 'hello', response: '   ' },
    });

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.errors.emptyResponse'));
  });

  it('requires an explicit channel when more than one is linked', async () => {
    const { c, replies } = buildContext(
      { group: 'command', sub: 'add', strings: { name: 'hello', response: 'hi there' } },
      { prismaOverrides: { twitchChatChannel: { findMany: async () => [CHANNEL_1, CHANNEL_2] } } },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.errors.channelRequired'));
  });

  it('rejects a name that already exists for the resolved channel', async () => {
    const create = vi.fn();
    const { c, replies } = buildContext(
      { group: 'command', sub: 'add', strings: { name: 'hello', response: 'hi there' } },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatCommand: { findUnique: async () => ({ id: 'existing' }), create },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(create).not.toHaveBeenCalled();
    expect(descriptionOf(replies)).toContain(realT('twitch.errors.commandExists', { name: 'hello' }));
  });

  it('rejects once the channel is at its command cap', async () => {
    const create = vi.fn();
    const { c, replies } = buildContext(
      { group: 'command', sub: 'add', strings: { name: 'hello', response: 'hi there' } },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatCommand: { findUnique: async () => null, count: async () => 50, create },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(create).not.toHaveBeenCalled();
    expect(descriptionOf(replies)).toContain(realT('twitch.errors.commandLimit', { max: 50 }));
  });
});

describe('/twitch command add — success', () => {
  it('auto-resolves the only linked channel, creates the row, audits, and nudges reconcile', async () => {
    const created: unknown[] = [];
    const audit = vi.fn(async () => undefined);
    const reconcileNow = vi.fn(async () => undefined);
    const { c, replies } = buildContext(
      {
        group: 'command',
        sub: 'add',
        strings: { name: 'HELLO', response: 'Hi {user}!', level: 'moderator' },
        integers: { cooldown: 10 },
      },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatCommand: {
            findUnique: async () => null,
            count: async () => 0,
            create: async (args: unknown) => {
              created.push(args);
              return { id: 'cmd1', name: 'hello' };
            },
          },
        },
        overrides: { audit },
      },
    );
    c.ctx.services.register(
      'twitchChat',
      { status: () => undefined, reconcileNow, stop: async () => undefined } as never,
    );

    await twitchCommand.execute(c);

    expect(created).toHaveLength(1);
    expect((created[0] as { data: Record<string, unknown> }).data).toMatchObject({
      channelId: CHANNEL_1.id,
      guildId: GUILD_ID,
      name: 'hello', // normalized to lowercase
      response: 'Hi {user}!',
      cooldownSeconds: 10,
      minLevel: 'MODERATOR',
      createdBy: USER_ID,
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(reconcileNow).toHaveBeenCalledTimes(1);
    expect(descriptionOf(replies)).toContain(
      realT('twitch.command.added', { name: 'hello', channel: CHANNEL_1.broadcasterLogin }),
    );
  });
});

describe('/twitch command remove', () => {
  it('reports not found when no command matches the name', async () => {
    const { c, replies } = buildContext(
      { group: 'command', sub: 'remove', strings: { name: 'missing' } },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatCommand: { findUnique: async () => null },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.errors.commandNotFound', { name: 'missing' }));
  });

  it('deletes immediately, audits, and nudges reconcile when fast actions are on', async () => {
    const del = vi.fn(async () => undefined);
    const audit = vi.fn(async () => undefined);
    const reconcileNow = vi.fn(async () => undefined);
    const { c, replies } = buildContext(
      { group: 'command', sub: 'remove', strings: { name: 'hello' } },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatCommand: { findUnique: async () => ({ id: 'cmd1', name: 'hello' }), delete: del },
        },
      },
    );
    c.ctx.services.register('host', { getGuildConfig: async () => ({ fastActions: true }) } as never);
    c.ctx.services.register(
      'twitchChat',
      { status: () => undefined, reconcileNow, stop: async () => undefined } as never,
    );
    const auditSpy = vi.spyOn(c.ctx, 'audit').mockImplementation(audit);

    await twitchCommand.execute(c);

    expect(del).toHaveBeenCalledWith({ where: { id: 'cmd1' } });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(reconcileNow).toHaveBeenCalledTimes(1);
    expect(descriptionOf(replies)).toContain(realT('twitch.command.removed', { name: 'hello' }));
  });

  it('sends a confirmation prompt (and deletes nothing yet) when fast actions are off', async () => {
    const del = vi.fn(async () => undefined);
    const { c, replies } = buildContext(
      { group: 'command', sub: 'remove', strings: { name: 'hello' } },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatCommand: { findUnique: async () => ({ id: 'cmd1', name: 'hello' }), delete: del },
        },
      },
    );
    c.ctx.services.register('host', { getGuildConfig: async () => ({ fastActions: false }) } as never);

    await twitchCommand.execute(c);

    expect(del).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]?.components).toHaveLength(1);
  });
});

describe('/twitch timer add — success', () => {
  it('creates a timer row for the resolved channel', async () => {
    const created: unknown[] = [];
    const { c, replies } = buildContext(
      {
        group: 'timer',
        sub: 'add',
        strings: { name: 'social', message: 'Follow us!' },
        integers: { 'interval-minutes': 30 },
      },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatTimer: {
            findUnique: async () => null,
            count: async () => 0,
            create: async (args: unknown) => {
              created.push(args);
              return { id: 'timer1', name: 'social' };
            },
          },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(created).toHaveLength(1);
    expect((created[0] as { data: Record<string, unknown> }).data).toMatchObject({
      channelId: CHANNEL_1.id,
      guildId: GUILD_ID,
      name: 'social',
      message: 'Follow us!',
      intervalMinutes: 30,
      createdBy: USER_ID,
    });
    expect(descriptionOf(replies)).toContain(
      realT('twitch.timer.added', { name: 'social', channel: CHANNEL_1.broadcasterLogin, interval: 30 }),
    );
  });
});

describe('/twitch status — channel points', () => {
  it('reports rewards off for a channel with rewardsEnabled=false', async () => {
    const { c, replies } = buildContext(
      { sub: 'status' },
      {
        prismaOverrides: {
          twitchBotIdentity: { findFirst: async () => null },
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.status.rewardsDisabled'));
  });

  it('reports re-link required when rewards are on but the stored token lacks the redemptions scope', async () => {
    const channel = { ...CHANNEL_1, rewardsEnabled: true, connectionId: 'conn-1' };
    const { c, replies } = buildContext(
      { sub: 'status' },
      {
        prismaOverrides: {
          twitchBotIdentity: { findFirst: async () => null },
          twitchChatChannel: { findMany: async () => [channel] },
          oAuthToken: { findUnique: async () => ({ scopes: ['channel:bot'] }) },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.status.rewardsRelinkRequired'));
  });

  it('reports re-link required when rewards are on but there is no stored token at all', async () => {
    const channel = { ...CHANNEL_1, rewardsEnabled: true, connectionId: 'conn-1' };
    const { c, replies } = buildContext(
      { sub: 'status' },
      {
        prismaOverrides: {
          twitchBotIdentity: { findFirst: async () => null },
          twitchChatChannel: { findMany: async () => [channel] },
          oAuthToken: { findUnique: async () => null },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.status.rewardsRelinkRequired'));
  });

  it('reports the overlay as set up once the scope is present and an overlay token exists', async () => {
    const channel = { ...CHANNEL_1, rewardsEnabled: true, connectionId: 'conn-1', overlayTokenEnc: 'enc-token' };
    const { c, replies } = buildContext(
      { sub: 'status' },
      {
        prismaOverrides: {
          twitchBotIdentity: { findFirst: async () => null },
          twitchChatChannel: { findMany: async () => [channel] },
          oAuthToken: { findUnique: async () => ({ scopes: ['channel:read:redemptions'] }) },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.status.rewardsEnabledOverlayReady'));
  });

  it('reports the overlay as not set up yet when the scope is present but no overlay token exists', async () => {
    const channel = { ...CHANNEL_1, rewardsEnabled: true, connectionId: 'conn-1' };
    const { c, replies } = buildContext(
      { sub: 'status' },
      {
        prismaOverrides: {
          twitchBotIdentity: { findFirst: async () => null },
          twitchChatChannel: { findMany: async () => [channel] },
          oAuthToken: { findUnique: async () => ({ scopes: ['channel:read:redemptions'] }) },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.status.rewardsEnabledNoOverlay'));
  });
});

describe('/twitch setup — channel points', () => {
  it('includes the dashboard click-path for rewards + the overlay/OBS step', async () => {
    const { c, replies } = buildContext(
      { sub: 'setup' },
      { prismaOverrides: { twitchBotIdentity: { findFirst: async () => ({ botLogin: 'pavisie_bot' }) } } },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.setup.rewardsInstructions'));
  });
});

describe('/twitch reward add — validation', () => {
  it('rejects a SOUND action missing sound-url', async () => {
    const { c, replies } = buildContext({
      group: 'reward',
      sub: 'add',
      strings: { 'reward-title': 'Hydrate', action: 'sound' },
    });

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(
      realT('twitch.errors.rewardFieldRequired', { field: 'sound-url', action: 'Sound effect' }),
    );
  });

  it('rejects a SOUND action carrying a text field (does not apply to this action)', async () => {
    const { c, replies } = buildContext({
      group: 'reward',
      sub: 'add',
      strings: {
        'reward-title': 'Hydrate',
        action: 'sound',
        'sound-url': 'https://93.184.216.34/a.mp3',
        text: 'nope',
      },
    });

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(
      realT('twitch.errors.rewardFieldNotAllowed', { field: 'text', action: 'Sound effect' }),
    );
  });

  it('rejects a TTS action missing text', async () => {
    const { c, replies } = buildContext({
      group: 'reward',
      sub: 'add',
      strings: { 'reward-title': 'Say hi', action: 'tts' },
    });

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(
      realT('twitch.errors.rewardFieldRequired', { field: 'text', action: 'Text-to-speech' }),
    );
  });

  it('rejects a CHAT action missing text', async () => {
    const { c, replies } = buildContext({
      group: 'reward',
      sub: 'add',
      strings: { 'reward-title': 'Shoutout', action: 'chat' },
    });

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(
      realT('twitch.errors.rewardFieldRequired', { field: 'text', action: 'Chat message' }),
    );
  });

  it('rejects a DISCORD action missing discord-channel', async () => {
    const { c, replies } = buildContext({
      group: 'reward',
      sub: 'add',
      strings: { 'reward-title': 'Post it', action: 'discord', text: 'hi' },
    });

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(
      realT('twitch.errors.rewardFieldRequired', { field: 'discord-channel', action: 'Discord post' }),
    );
  });

  it('rejects a DISCORD action missing text', async () => {
    const { c, replies } = buildContext({
      group: 'reward',
      sub: 'add',
      strings: { 'reward-title': 'Post it', action: 'discord' },
      channels: { 'discord-channel': { id: 'dchan1' } },
    });

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(
      realT('twitch.errors.rewardFieldRequired', { field: 'text', action: 'Discord post' }),
    );
  });

  it('rejects a sound-url that resolves to a private address (SSRF)', async () => {
    const { c, replies } = buildContext(
      {
        group: 'reward',
        sub: 'add',
        strings: { 'reward-title': 'Hydrate', action: 'sound', 'sound-url': 'https://127.0.0.1/a.mp3' },
      },
      { prismaOverrides: { twitchChatChannel: { findMany: async () => [CHANNEL_1] } } },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(
      realT('errors.invalidUrl', { reason: 'Requests to private/internal IP addresses are not allowed.' }),
    );
  });

  it('rejects once the channel is at its reward cap', async () => {
    const create = vi.fn();
    const { c, replies } = buildContext(
      {
        group: 'reward',
        sub: 'add',
        strings: { 'reward-title': 'Say hi', action: 'tts', text: 'Hello {user}!' },
      },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatReward: { findFirst: async () => null, count: async () => 25, create },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(create).not.toHaveBeenCalled();
    expect(descriptionOf(replies)).toContain(realT('twitch.errors.rewardLimit', { max: 25 }));
  });

  it('rejects a title+action that already exists for the resolved channel', async () => {
    const create = vi.fn();
    const { c, replies } = buildContext(
      {
        group: 'reward',
        sub: 'add',
        strings: { 'reward-title': 'Say hi', action: 'tts', text: 'Hello {user}!' },
      },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatReward: { findFirst: async () => ({ id: 'existing' }), create },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(create).not.toHaveBeenCalled();
    expect(descriptionOf(replies)).toContain(realT('twitch.errors.rewardExists', { name: 'Say hi' }));
  });
});

describe('/twitch reward add — success', () => {
  it('creates a SOUND reward row for the resolved channel, audits, and nudges reconcile', async () => {
    const created: unknown[] = [];
    const audit = vi.fn(async () => undefined);
    const reconcileNow = vi.fn(async () => undefined);
    const { c, replies } = buildContext(
      {
        group: 'reward',
        sub: 'add',
        strings: { 'reward-title': 'Hydrate', action: 'sound', 'sound-url': 'https://93.184.216.34/a.mp3' },
        integers: { volume: 50, cooldown: 30 },
      },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatReward: {
            findFirst: async () => null,
            count: async () => 0,
            create: async (args: unknown) => {
              created.push(args);
              return { id: 'reward1', rewardTitle: 'Hydrate' };
            },
          },
        },
        overrides: { audit },
      },
    );
    c.ctx.services.register(
      'twitchChat',
      { status: () => undefined, reconcileNow, stop: async () => undefined } as never,
    );

    await twitchCommand.execute(c);

    expect(created).toHaveLength(1);
    expect((created[0] as { data: Record<string, unknown> }).data).toMatchObject({
      channelId: CHANNEL_1.id,
      guildId: GUILD_ID,
      rewardId: null, // no broadcaster token available in this fixture — falls back to title-only matching
      rewardTitle: 'Hydrate',
      action: 'SOUND',
      soundUrl: 'https://93.184.216.34/a.mp3',
      volume: 50,
      ttsTemplate: null,
      chatTemplate: null,
      discordChannelId: null,
      discordTemplate: null,
      cooldownSeconds: 30,
      createdBy: USER_ID,
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(reconcileNow).toHaveBeenCalledTimes(1);
    expect(descriptionOf(replies)).toContain(
      realT('twitch.reward.added', {
        title: 'Hydrate',
        action: 'Sound effect',
        channel: CHANNEL_1.broadcasterLogin,
      }),
    );
  });

  it('creates a DISCORD reward row with the chosen channel and template', async () => {
    const created: unknown[] = [];
    const { c, replies } = buildContext(
      {
        group: 'reward',
        sub: 'add',
        strings: { 'reward-title': 'Shoutout', action: 'discord', text: '{user} redeemed a shoutout!' },
        channels: { 'discord-channel': { id: 'dchan1' } },
      },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatReward: {
            findFirst: async () => null,
            count: async () => 0,
            create: async (args: unknown) => {
              created.push(args);
              return { id: 'reward2', rewardTitle: 'Shoutout' };
            },
          },
        },
      },
    );

    await twitchCommand.execute(c);

    expect((created[0] as { data: Record<string, unknown> }).data).toMatchObject({
      action: 'DISCORD',
      discordChannelId: 'dchan1',
      discordTemplate: '{user} redeemed a shoutout!',
      soundUrl: null,
      ttsTemplate: null,
      chatTemplate: null,
    });
    expect(descriptionOf(replies)).toContain(
      realT('twitch.reward.added', {
        title: 'Shoutout',
        action: 'Discord post',
        channel: CHANNEL_1.broadcasterLogin,
      }),
    );
  });
});

describe('/twitch reward remove', () => {
  it('reports not found when no reward matches the title', async () => {
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'remove', strings: { 'reward-title': 'missing' } },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatReward: { findMany: async () => [] },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.errors.rewardNotFound', { name: 'missing' }));
  });

  it('reports ambiguous when the title matches more than one action', async () => {
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'remove', strings: { 'reward-title': 'Hydrate' } },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatReward: {
            findMany: async () => [
              { id: 'r1', rewardTitle: 'Hydrate', action: 'SOUND' },
              { id: 'r2', rewardTitle: 'Hydrate', action: 'TTS' },
            ],
          },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.errors.rewardAmbiguous', { name: 'Hydrate' }));
  });

  it('deletes immediately, audits, and nudges reconcile when fast actions are on', async () => {
    const del = vi.fn(async () => undefined);
    const audit = vi.fn(async () => undefined);
    const reconcileNow = vi.fn(async () => undefined);
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'remove', strings: { 'reward-title': 'Hydrate' } },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatReward: {
            findMany: async () => [{ id: 'r1', rewardTitle: 'Hydrate', action: 'SOUND' }],
            delete: del,
          },
        },
      },
    );
    c.ctx.services.register('host', { getGuildConfig: async () => ({ fastActions: true }) } as never);
    c.ctx.services.register(
      'twitchChat',
      { status: () => undefined, reconcileNow, stop: async () => undefined } as never,
    );
    const auditSpy = vi.spyOn(c.ctx, 'audit').mockImplementation(audit);

    await twitchCommand.execute(c);

    expect(del).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(reconcileNow).toHaveBeenCalledTimes(1);
    expect(descriptionOf(replies)).toContain(realT('twitch.reward.removed', { title: 'Hydrate' }));
  });

  it('sends a confirmation prompt (and deletes nothing yet) when fast actions are off', async () => {
    const del = vi.fn(async () => undefined);
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'remove', strings: { 'reward-title': 'Hydrate' } },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatReward: {
            findMany: async () => [{ id: 'r1', rewardTitle: 'Hydrate', action: 'SOUND' }],
            delete: del,
          },
        },
      },
    );
    c.ctx.services.register('host', { getGuildConfig: async () => ({ fastActions: false }) } as never);

    await twitchCommand.execute(c);

    expect(del).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]?.components).toHaveLength(1);
  });
});

describe('/twitch reward list', () => {
  it('lists reward rows with the action label and cooldown', async () => {
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'list' },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [CHANNEL_1] },
          twitchChatReward: {
            findMany: async () => [{ rewardTitle: 'Hydrate', action: 'SOUND', cooldownSeconds: 30, enabled: true }],
          },
        },
      },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(
      realT('twitch.reward.listLine', { title: 'Hydrate', action: 'Sound effect', cooldown: 30, disabled: '' }),
    );
  });

  it('shows the empty state with no reward rows', async () => {
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'list' },
      { prismaOverrides: { twitchChatChannel: { findMany: async () => [CHANNEL_1] } } },
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.reward.listEmpty'));
  });
});

describe('/twitch reward enable', () => {
  it('enables rewards on the channel, audits, nudges reconcile, and warns when re-link is needed', async () => {
    const update = vi.fn(async () => undefined);
    const audit = vi.fn(async () => undefined);
    const reconcileNow = vi.fn(async () => undefined);
    const channelWithoutScope = { ...CHANNEL_1, connectionId: 'conn-1' };
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'enable' },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [channelWithoutScope], update },
          oAuthToken: { findUnique: async () => ({ scopes: ['channel:bot'] }) },
        },
        overrides: { audit },
      },
    );
    c.ctx.services.register(
      'twitchChat',
      { status: () => undefined, reconcileNow, stop: async () => undefined } as never,
    );

    await twitchCommand.execute(c);

    expect(update).toHaveBeenCalledWith({ where: { id: channelWithoutScope.id }, data: { rewardsEnabled: true } });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(reconcileNow).toHaveBeenCalledTimes(1);
    expect(descriptionOf(replies)).toContain(realT('twitch.reward.enabledRelinkRequired', { channel: channelWithoutScope.broadcasterLogin }));
  });

  it('enables rewards and confirms when the token has the required scope', async () => {
    const update = vi.fn(async () => undefined);
    const channelWithScope = { ...CHANNEL_1, connectionId: 'conn-1' };
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'enable' },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [channelWithScope], update },
          oAuthToken: { findUnique: async () => ({ scopes: ['channel:read:redemptions'] }) },
        },
      },
    );
    c.ctx.services.register(
      'twitchChat',
      { status: () => undefined, reconcileNow: async () => undefined, stop: async () => undefined } as never,
    );

    await twitchCommand.execute(c);

    expect(descriptionOf(replies)).toContain(realT('twitch.reward.enabled', { channel: channelWithScope.broadcasterLogin }));
  });
});

describe('/twitch reward disable', () => {
  it('disables rewards on the channel, audits, and nudges reconcile', async () => {
    const update = vi.fn(async () => undefined);
    const audit = vi.fn(async () => undefined);
    const reconcileNow = vi.fn(async () => undefined);
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'disable' },
      { prismaOverrides: { twitchChatChannel: { findMany: async () => [CHANNEL_1], update } }, overrides: { audit } },
    );
    c.ctx.services.register(
      'twitchChat',
      { status: () => undefined, reconcileNow, stop: async () => undefined } as never,
    );

    await twitchCommand.execute(c);

    expect(update).toHaveBeenCalledWith({ where: { id: CHANNEL_1.id }, data: { rewardsEnabled: false } });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(reconcileNow).toHaveBeenCalledTimes(1);
    expect(descriptionOf(replies)).toContain(realT('twitch.reward.disabled', { channel: CHANNEL_1.broadcasterLogin }));
  });
});

describe('/twitch reward overlay', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'encryptSecret').mockImplementation((val) => `enc(${val})`);
    vi.spyOn(crypto, 'decryptSecret').mockImplementation((val) => val.replace(/^enc\(/, '').replace(/\)$/, ''));
  });

  it('generates a token on first use, persists encrypted value, writes Redis index, and replies ephemerally with the URL', async () => {
    const update = vi.fn(async () => undefined);
    const redisSet = vi.fn(async () => undefined);
    const channelWithoutToken = { ...CHANNEL_1, overlayTokenEnc: null };
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'overlay' },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [channelWithoutToken], update },
        },
      },
    );
    c.ctx.redis.set = redisSet as never;
    c.ctx.env.API_BASE_URL = 'https://api.example.com';

    await twitchCommand.execute(c);

    expect(update).toHaveBeenCalledWith({ where: { id: CHANNEL_1.id }, data: { overlayTokenEnc: expect.any(String) } });
    expect(redisSet).toHaveBeenCalledWith(expect.stringContaining('overlay:token:'), CHANNEL_1.id);
    expect(replies[0]?.ephemeral).toBe(true);
    expect(descriptionOf(replies)).toContain('https://api.example.com/overlay/');
  });

  it('returns the same URL when called twice (does not silently rotate)', async () => {
    const token = 'existing-token';
    const encryptedToken = `enc(${token})`;
    const channelWithToken = { ...CHANNEL_1, overlayTokenEnc: encryptedToken };
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'overlay' },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [channelWithToken] },
        },
      },
    );
    c.ctx.env.API_BASE_URL = 'https://api.example.com';

    await twitchCommand.execute(c);

    expect(replies[0]?.ephemeral).toBe(true);
    expect(descriptionOf(replies)).toContain(`https://api.example.com/overlay/${token}`);
  });
});

describe('/twitch reward overlay-reset', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'encryptSecret').mockImplementation((val) => `enc(${val})`);
    vi.spyOn(crypto, 'decryptSecret').mockImplementation((val) => val.replace(/^enc\(/, '').replace(/\)$/, ''));
  });

  it('requires confirmation and warns that the old URL will stop working', async () => {
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'overlay-reset' },
      { prismaOverrides: { twitchChatChannel: { findMany: async () => [CHANNEL_1] } } },
    );
    c.ctx.services.register('host', { getGuildConfig: async () => ({ fastActions: false }) } as never);

    await twitchCommand.execute(c);

    expect(replies).toHaveLength(1);
    expect(replies[0]?.components).toHaveLength(1);
    const embeds = replies[0]?.embeds;
    expect(embeds?.[0]?.data.description).toContain(realT('twitch.reward.overlayResetConfirmBody', { channel: CHANNEL_1.broadcasterLogin }));
  });

  it('regenerates token and removes old Redis index when confirmed with fast actions on', async () => {
    const update = vi.fn(async () => undefined);
    const redisDel = vi.fn(async () => undefined);
    const redisSet = vi.fn(async () => undefined);
    const audit = vi.fn(async () => undefined);
    const channelWithToken = { ...CHANNEL_1, overlayTokenEnc: 'enc(oldtoken)' };
    const { c, replies } = buildContext(
      { group: 'reward', sub: 'overlay-reset' },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [channelWithToken], update },
        },
        overrides: { audit },
      },
    );
    c.ctx.redis.del = redisDel as never;
    c.ctx.redis.set = redisSet as never;
    c.ctx.services.register('host', { getGuildConfig: async () => ({ fastActions: true }) } as never);

    await twitchCommand.execute(c);

    expect(update).toHaveBeenCalledWith({ where: { id: CHANNEL_1.id }, data: { overlayTokenEnc: expect.any(String) } });
    expect(redisSet).toHaveBeenCalledWith(expect.stringContaining('overlay:token:'), CHANNEL_1.id);
    expect(redisDel).toHaveBeenCalledWith(expect.stringContaining('overlay:token:'));
    expect(audit).toHaveBeenCalledTimes(1);
    expect(descriptionOf(replies)).toContain(realT('twitch.reward.overlayResetDone', { channel: CHANNEL_1.broadcasterLogin }));
  });

  it('never includes the raw token or URL in the audit payload', async () => {
    const update = vi.fn(async () => undefined);
    const auditCalls: unknown[] = [];
    const channelWithToken = { ...CHANNEL_1, overlayTokenEnc: 'enc(oldtoken)' };
    const { c } = buildContext(
      { group: 'reward', sub: 'overlay-reset' },
      {
        prismaOverrides: {
          twitchChatChannel: { findMany: async () => [channelWithToken], update },
        },
        overrides: {
          audit: async (entry) => {
            auditCalls.push(entry);
          },
        },
      },
    );
    c.ctx.redis.set = vi.fn(async () => undefined) as never;
    c.ctx.redis.del = vi.fn(async () => undefined) as never;
    c.ctx.services.register('host', { getGuildConfig: async () => ({ fastActions: true }) } as never);

    await twitchCommand.execute(c);

    expect(auditCalls).toHaveLength(1);
    const auditEntry = auditCalls[0] as Record<string, unknown>;
    const auditStr = JSON.stringify(auditEntry);
    expect(auditStr).not.toMatch(/overlay\//);
    expect(auditStr).not.toMatch(/https:\/\//);
  });
});

describe('twitchConfirmComponents', () => {
  it('registers confirm/cancel handlers for off, command-remove, timer-remove, reward-remove, and overlay-reset', () => {
    const actions = twitchConfirmComponents.map((h) => h.action).sort();
    expect(actions).toEqual(
      [
        'confirm-twitch-off',
        'cancel-twitch-off',
        'confirm-twitch-command-remove',
        'cancel-twitch-command-remove',
        'confirm-twitch-timer-remove',
        'cancel-twitch-timer-remove',
        'confirm-twitch-reward-remove',
        'cancel-twitch-reward-remove',
        'confirm-twitch-overlay-reset',
        'cancel-twitch-overlay-reset',
      ].sort(),
    );
  });
});
