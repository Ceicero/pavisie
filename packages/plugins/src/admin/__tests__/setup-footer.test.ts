import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { command } from '../commands/setup';

function build(enabled: boolean) {
  const setPluginConfig = vi.fn(async () => ({}));
  const reply = vi.fn(async (..._args: unknown[]) => undefined);
  const { ctx, services } = createTestContext();
  services.register('host', { setPluginConfig } as never);
  const c: CommandContext = {
    interaction: {
      user: { id: 'admin-1' },
      options: { getSubcommand: () => 'footer', getBoolean: () => enabled },
      reply,
    } as never,
    ctx,
    guildId: 'g1',
    staffLevel: 'admin',
    locale: 'en-US' as never,
    t: (key: string) => key,
    config: async <T>() => ({}) as T,
  };
  return { c, setPluginConfig, reply };
}

describe('/setup footer', () => {
  it('is a required-boolean subcommand of /setup', () => {
    const json = command.data.toJSON() as {
      options: { name: string; options?: { name: string; required?: boolean }[] }[];
    };
    expect(json.options.find((o) => o.name === 'footer')?.options).toMatchObject([
      { name: 'enabled', required: true },
    ]);
  });

  it.each([false, true])(
    'saves admin.poweredByFooter=%s through the host service as the invoking admin',
    async (enabled) => {
      const { c, setPluginConfig, reply } = build(enabled);
      await command.execute(c);
      expect(setPluginConfig).toHaveBeenCalledWith(
        'g1',
        'admin',
        { poweredByFooter: enabled },
        { id: 'admin-1', source: 'bot' },
      );
      const payload = reply.mock.calls[0]?.[0] as {
        ephemeral: boolean;
        embeds: { toJSON: () => { description: string } }[];
      };
      expect(payload.ephemeral).toBe(true);
      expect(payload.embeds[0]?.toJSON().description).toContain(
        enabled ? 'setup.footer.on' : 'setup.footer.off',
      );
    },
  );

  it('is admin-only', async () => {
    const { c, setPluginConfig } = build(false);
    c.staffLevel = 'moderator';
    await expect(command.execute(c)).rejects.toThrow();
    expect(setPluginConfig).not.toHaveBeenCalled();
  });
});
