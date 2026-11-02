import { ChannelType } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamerStarterReportDto } from '@pavisie/types';
import type { CommandContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';

const { runStreamerStarter, StarterAlreadyRunningError } = vi.hoisted(() => ({
  runStreamerStarter: vi.fn(),
  StarterAlreadyRunningError: class StarterAlreadyRunningError extends Error {},
}));
vi.mock('../starter-pack-runtime', () => ({ runStreamerStarter, StarterAlreadyRunningError }));

const { command } = await import('../commands/setup');

const REPORT: StreamerStarterReportDto = {
  guildId: 'g1',
  ranAt: '2026-01-01T00:00:00.000Z',
  steps: [
    {
      id: 'twitch',
      status: 'enabled',
      title: 'Twitch go-live alerts',
      text: 'Watching **shroud**',
      where: 'Dashboard',
    },
    { id: 'stats', status: 'skipped', title: 'Server stats channel', text: 'Skipped', where: 'Dashboard' },
  ],
  notes: ['heads up'],
};

function build(options: {
  login?: string | null;
  channel?: { id: string } | null;
  here?: { id: string; type: ChannelType } | null;
}) {
  const interaction = {
    user: { id: 'admin-1' },
    guild: { id: 'g1' },
    channel: options.here === undefined ? { id: 'here-1', type: ChannelType.GuildText } : options.here,
    options: {
      getSubcommand: () => 'streamer',
      getString: (name: string) => (name === 'twitch_login' ? (options.login ?? null) : null),
      getChannel: (name: string) => (name === 'alert_channel' ? (options.channel ?? null) : null),
    },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async (..._args: unknown[]) => undefined),
    reply: vi.fn(async () => undefined),
  };
  const { ctx } = createTestContext();
  const c: CommandContext = {
    interaction: interaction as never,
    ctx,
    guildId: 'g1',
    staffLevel: 'admin',
    locale: 'en-US' as never,
    t: (key: string) => key,
    config: async <T>() => ({}) as T,
  };
  return { c, interaction };
}

describe('/setup streamer', () => {
  beforeEach(() => {
    runStreamerStarter.mockReset();
  });

  it('is a subcommand of /setup with optional twitch_login and alert_channel', () => {
    const json = command.data.toJSON() as {
      options: { name: string; options?: { name: string; required?: boolean }[] }[];
    };
    const streamer = json.options.find((o) => o.name === 'streamer');
    expect(streamer?.options?.map((o) => [o.name, Boolean(o.required)])).toEqual([
      ['twitch_login', false],
      ['alert_channel', false],
    ]);
  });

  it('keeps the same admin / Manage Server gate as the rest of /setup', () => {
    expect(command.requirement).toEqual({ staffLevel: 'admin', guildOnly: true });
    expect((command.data.toJSON() as { default_member_permissions: string }).default_member_permissions).toBe(
      '32',
    );
  });

  it('defaults the alert channel to the channel it was run in and replies with the report embed', async () => {
    runStreamerStarter.mockResolvedValue(REPORT);
    const { c, interaction } = build({ login: 'shroud' });

    await command.execute(c);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(runStreamerStarter).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { twitchLogin: 'shroud', alertChannelId: 'here-1' },
        actor: { id: 'admin-1', source: 'bot' },
      }),
    );
    const reply = interaction.editReply.mock.calls[0]?.[0] as {
      embeds: { toJSON: () => { fields: { name: string }[] } }[];
    };
    expect(reply.embeds[0]?.toJSON().fields.map((f) => f.name)).toEqual([
      '✅ Twitch go-live alerts',
      '⚠️ Server stats channel',
      'setup.streamer.notesTitle',
    ]);
  });

  it('uses the alert_channel option over the current channel', async () => {
    runStreamerStarter.mockResolvedValue(REPORT);
    const { c } = build({ login: 'shroud', channel: { id: 'picked-1' } });
    await command.execute(c);
    expect(runStreamerStarter).toHaveBeenCalledWith(
      expect.objectContaining({ input: { twitchLogin: 'shroud', alertChannelId: 'picked-1' } }),
    );
  });

  it('does not default to a channel an alert cannot be posted in (a thread)', async () => {
    runStreamerStarter.mockResolvedValue(REPORT);
    const { c } = build({ login: 'shroud', here: { id: 'thread-1', type: ChannelType.PublicThread } });
    await command.execute(c);
    expect(runStreamerStarter).toHaveBeenCalledWith(
      expect.objectContaining({ input: { twitchLogin: 'shroud', alertChannelId: null } }),
    );
  });

  it('answers with an error embed when a run is already in progress', async () => {
    runStreamerStarter.mockImplementation(async () => {
      throw new StarterAlreadyRunningError();
    });
    const { c, interaction } = build({});
    await command.execute(c);
    const reply = interaction.editReply.mock.calls[0]?.[0] as {
      embeds: { toJSON: () => { description: string } }[];
    };
    expect(reply.embeds[0]?.toJSON().description).toContain('setup.streamer.alreadyRunning');
  });

  it('refuses callers below admin before doing anything', async () => {
    const { c } = build({});
    c.staffLevel = 'moderator';
    await expect(command.execute(c)).rejects.toThrow();
    expect(runStreamerStarter).not.toHaveBeenCalled();
  });
});
