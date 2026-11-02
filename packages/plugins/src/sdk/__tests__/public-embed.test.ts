import { EmbedBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { AlertEmbedData } from '../../integrations/formatters/types';
import { postAlert } from '../../integrations/embeds';
import { createTestContext } from '../testing';
import {
  POWERED_BY_CONFIG_KEY,
  POWERED_BY_TEXT,
  isPoweredByFooterEnabled,
  publicEmbed,
  withPoweredByFooter,
} from '../public-embed';
import { brandEmbed } from '../embeds';
import { configSchema as adminConfigSchema } from '../../admin/manifest';

const GUILD = '111111111111111111';
const ICON = 'https://cdn.example/icon.png';

function footerOf(embed: EmbedBuilder) {
  return embed.data.footer;
}

describe('withPoweredByFooter', () => {
  it('adds the attribution to an embed with no footer', () => {
    const embed = withPoweredByFooter(new EmbedBuilder().setTitle('Giveaway'));
    expect(footerOf(embed)?.text).toBe('Powered by Pavisie');
  });

  it('leaves the embed completely untouched when switched off', () => {
    const bare = withPoweredByFooter(new EmbedBuilder().setTitle('x'), false);
    expect(footerOf(bare)).toBeUndefined();

    const custom = withPoweredByFooter(
      new EmbedBuilder().setFooter({ text: 'Twitch', iconURL: ICON }),
      false,
    );
    expect(footerOf(custom)).toEqual({ text: 'Twitch', icon_url: ICON });
  });

  it('appends to a footer that already has text instead of replacing it, keeping its icon', () => {
    const embed = withPoweredByFooter(new EmbedBuilder().setFooter({ text: 'Twitch', iconURL: ICON }));
    expect(footerOf(embed)).toEqual({ text: 'Twitch · Powered by Pavisie', icon_url: ICON });
  });

  it('treats the plain brand footer as already saying the same thing and replaces it', () => {
    const embed = withPoweredByFooter(brandEmbed());
    expect(footerOf(embed)?.text).toBe('Powered by Pavisie');
  });

  it('is idempotent', () => {
    const once = withPoweredByFooter(new EmbedBuilder().setFooter({ text: 'Reddit' }));
    const twice = withPoweredByFooter(once);
    expect(footerOf(twice)?.text).toBe('Reddit · Powered by Pavisie');

    const alreadyBare = withPoweredByFooter(withPoweredByFooter(new EmbedBuilder()));
    expect(footerOf(alreadyBare)?.text).toBe('Powered by Pavisie');
  });

  it("shortens the existing text, never the attribution, when the two would exceed Discord's limit", () => {
    const embed = withPoweredByFooter(new EmbedBuilder().setFooter({ text: 'x'.repeat(2048) }));
    const text = footerOf(embed)?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(2048);
    expect(text.endsWith(` · ${POWERED_BY_TEXT}`)).toBe(true);
  });

  it('returns the same builder it was given', () => {
    const embed = new EmbedBuilder();
    expect(withPoweredByFooter(embed)).toBe(embed);
  });
});

describe('isPoweredByFooterEnabled', () => {
  function ctxWithAdminConfig(getPluginConfig: () => Promise<unknown>) {
    const { ctx, services } = createTestContext();
    services.register('host', { getPluginConfig } as never);
    return ctx;
  }

  it('is on by default, and when the host service is not there', async () => {
    expect(await isPoweredByFooterEnabled(createTestContext().ctx, GUILD)).toBe(true);
    expect(
      await isPoweredByFooterEnabled(
        ctxWithAdminConfig(async () => ({})),
        GUILD,
      ),
    ).toBe(true);
    expect(
      await isPoweredByFooterEnabled(
        ctxWithAdminConfig(async () => adminConfigSchema.parse({})),
        GUILD,
      ),
    ).toBe(true);
  });

  it('is off only when the admin turned admin.poweredByFooter off', async () => {
    const off = ctxWithAdminConfig(async () => ({ [POWERED_BY_CONFIG_KEY]: false }));
    expect(await isPoweredByFooterEnabled(off, GUILD)).toBe(false);
  });

  it('asks the admin plugin config of that guild', async () => {
    const getPluginConfig = vi.fn(async () => ({ poweredByFooter: true }));
    await isPoweredByFooterEnabled(ctxWithAdminConfig(getPluginConfig), GUILD);
    expect(getPluginConfig).toHaveBeenCalledWith(GUILD, 'admin');
  });

  it('stays on when the setting cannot be read, so a footer never stops a message from posting', async () => {
    const broken = ctxWithAdminConfig(async () => {
      throw new Error('redis down');
    });
    expect(await isPoweredByFooterEnabled(broken, GUILD)).toBe(true);
  });
});

describe('publicEmbed', () => {
  it('applies the guild setting', async () => {
    const { ctx, services } = createTestContext();
    services.register('host', { getPluginConfig: async () => ({ poweredByFooter: false }) } as never);
    const off = await publicEmbed(ctx, GUILD, new EmbedBuilder().setFooter({ text: 'Poll' }));
    expect(footerOf(off)?.text).toBe('Poll');

    services.register('host', { getPluginConfig: async () => ({ poweredByFooter: true }) } as never);
    const on = await publicEmbed(ctx, GUILD, new EmbedBuilder().setFooter({ text: 'Poll' }));
    expect(footerOf(on)?.text).toBe('Poll · Powered by Pavisie');
  });
});

describe('the admin config key', () => {
  it('exists in the admin plugin schema, defaulting to on, under the key the SDK reads', () => {
    const parsed = adminConfigSchema.parse({}) as Record<string, unknown>;
    expect(parsed[POWERED_BY_CONFIG_KEY]).toBe(true);
    expect(
      (adminConfigSchema.parse({ poweredByFooter: false }) as Record<string, unknown>)[POWERED_BY_CONFIG_KEY],
    ).toBe(false);
  });
});

describe('a public poster (integration go-live alerts)', () => {
  const alert: AlertEmbedData = { title: 'shroud is live', footer: 'Twitch' };

  function postWith(enabled: boolean) {
    const sent: { embeds: EmbedBuilder[] }[] = [];
    const channel = {
      isTextBased: () => true,
      type: 0,
      permissionsFor: () => ({ has: () => true }),
      send: async (payload: { embeds: EmbedBuilder[] }) => {
        sent.push(payload);
      },
    };
    const guild = {
      channels: { fetch: async () => channel },
      members: { me: {} },
    };
    const { ctx, services } = createTestContext({
      overrides: { client: { guilds: { fetch: async () => guild } } as never },
    });
    services.register('host', { getPluginConfig: async () => ({ poweredByFooter: enabled }) } as never);
    return { ctx, sent };
  }

  it('adds the attribution after the provider footer when on', async () => {
    const { ctx, sent } = postWith(true);
    expect(await postAlert(ctx, { guildId: GUILD, channelId: '2' }, alert)).toBe(true);
    expect(sent[0]?.embeds[0]?.data.footer?.text).toBe('Twitch · Powered by Pavisie');
  });

  it('leaves the provider footer exactly as it was when off', async () => {
    const { ctx, sent } = postWith(false);
    expect(await postAlert(ctx, { guildId: GUILD, channelId: '2' }, alert)).toBe(true);
    expect(sent[0]?.embeds[0]?.data.footer?.text).toBe('Twitch');
  });
});
