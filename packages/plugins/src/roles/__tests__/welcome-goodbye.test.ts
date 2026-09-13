import type { Guild } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { CommandContext, ComponentContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { buildSectionExecute } from '../commands/welcome-goodbye-shared';
import { welcomeEmbedModalHandler } from '../components/embed-modal';
import { formatEmbedColorHex, normalizeEmbedColor, normalizeStoredEmbed } from '../engine';
import type { RolesConfig, WelcomeGoodbyeConfig } from '../manifest';
import { renderWelcomeGoodbye } from '../service';

const guild = { name: 'Pavisie', memberCount: 42 } as unknown as Guild;
const member = { id: 'u1', user: { tag: 'alex', username: 'alex' } };

function welcomeSection(patch: Partial<WelcomeGoodbyeConfig>): WelcomeGoodbyeConfig {
  return {
    enabled: true,
    channelId: 'c1',
    message: null,
    embed: null,
    dm: false,
    ...patch,
  } as WelcomeGoodbyeConfig;
}

describe('embed colour normalisation', () => {
  it('converts a stored #rrggbb string into the integer Discord requires', () => {
    expect(normalizeEmbedColor('#5865f2')).toBe(0x5865f2);
    expect(normalizeEmbedColor('5865F2')).toBe(0x5865f2);
    expect(normalizeEmbedColor('  #e5e5e5 ')).toBe(0xe5e5e5);
  });

  it('passes an already-integer colour through and rejects out-of-range or junk values', () => {
    expect(normalizeEmbedColor(0x5865f2)).toBe(0x5865f2);
    expect(normalizeEmbedColor(-1)).toBeUndefined();
    expect(normalizeEmbedColor(0x1000000)).toBeUndefined();
    expect(normalizeEmbedColor('blurple')).toBeUndefined();
    expect(normalizeEmbedColor(null)).toBeUndefined();
    expect(normalizeEmbedColor(undefined)).toBeUndefined();
  });

  it('drops an unusable colour from the embed rather than sending it', () => {
    expect(normalizeStoredEmbed({ title: 'Hi', color: 'nope' })).toEqual({ title: 'Hi' });
    expect(normalizeStoredEmbed({ title: 'Hi' })).toEqual({ title: 'Hi' });
  });

  it('formats a stored colour back into hex for the modal prefill', () => {
    expect(formatEmbedColorHex(0x5865f2)).toBe('#5865f2');
    expect(formatEmbedColorHex('#5865f2')).toBe('#5865f2');
    expect(formatEmbedColorHex(0x0000ff)).toBe('#0000ff');
    expect(formatEmbedColorHex(undefined)).toBe('');
  });
});

describe('renderWelcomeGoodbye', () => {
  it('converts a legacy hex-string colour so Discord does not reject the message', () => {
    const rendered = renderWelcomeGoodbye(
      welcomeSection({ embed: { title: 'Welcome!', description: 'Hey {mention}', color: '#5865f2' } }),
      member,
      guild,
    );

    expect(rendered?.embed).toEqual({
      title: 'Welcome!',
      description: 'Hey <@u1>',
      color: 0x5865f2,
    });
  });

  it('leaves an integer colour and the rest of the embed untouched', () => {
    const rendered = renderWelcomeGoodbye(
      welcomeSection({
        embed: { title: 'Bye {user}', color: 0xe5e5e5, footer: { text: '{memberCount} members' } },
      }),
      member,
      guild,
    );

    expect(rendered?.embed).toEqual({
      title: 'Bye alex',
      color: 0xe5e5e5,
      footer: { text: '42 members' },
    });
  });
});

describe('/welcome embed modal', () => {
  it('stores the colour as an integer', async () => {
    let saved: Partial<RolesConfig> | undefined;
    const { ctx } = createTestContext({
      overrides: {
        setConfig: (<T>(_guildId: string, patch: Partial<T>) => {
          saved = patch as Partial<RolesConfig>;
          return Promise.resolve(patch as T);
        }) as never,
      },
    });

    const fields: Record<string, string> = {
      title: 'Welcome!',
      description: 'Hey {mention}',
      color: '#5865f2',
      footer: 'pavisie',
    };
    const c = {
      ctx,
      guildId: 'g1',
      interaction: {
        user: { id: 'u1' },
        fields: { getTextInputValue: (id: string) => fields[id] ?? '' },
        reply: () => Promise.resolve(undefined),
      },
      config: () => Promise.resolve({ welcome: welcomeSection({}) }),
    } as unknown as ComponentContext;

    await welcomeEmbedModalHandler.handler(c);

    expect(saved?.welcome?.embed).toEqual({
      title: 'Welcome!',
      description: 'Hey {mention}',
      color: 0x5865f2,
      footer: { text: 'pavisie' },
    });
  });

  it('re-opens the form pre-filled from a saved embed (footer stored as { text })', async () => {
    type TextInputJson = { custom_id: string; value?: string };
    const shown: TextInputJson[] = [];
    const { ctx } = createTestContext();
    const c = {
      ctx,
      guildId: 'g1',
      interaction: {
        user: { id: 'u1' },
        options: { getSubcommand: () => 'embed' },
        showModal: (modal: { toJSON: () => { components: { components: TextInputJson[] }[] } }) => {
          for (const row of modal.toJSON().components) shown.push(row.components[0]);
          return Promise.resolve(undefined);
        },
      },
      config: () =>
        Promise.resolve({
          welcome: welcomeSection({
            embed: { title: 'Hi', color: 0x5865f2, footer: { text: 'pavisie' } },
          }),
        }),
    } as unknown as CommandContext;

    await buildSectionExecute('welcome')(c);

    const byId = Object.fromEntries(shown.map((input) => [input.custom_id, input.value]));
    expect(byId.footer).toBe('pavisie');
    expect(byId.color).toBe('#5865f2');
    expect(byId.title).toBe('Hi');
  });

  it('re-opens the form for a guild whose stored colour is still a hex string', async () => {
    let opened = false;
    const { ctx } = createTestContext();
    const c = {
      ctx,
      guildId: 'g1',
      interaction: {
        user: { id: 'u1' },
        options: { getSubcommand: () => 'embed' },
        showModal: () => {
          opened = true;
          return Promise.resolve(undefined);
        },
      },
      config: () =>
        Promise.resolve({
          welcome: welcomeSection({ embed: { title: 'Hi', color: '#5865f2', footer: { text: 'x' } } }),
        }),
    } as unknown as CommandContext;

    await buildSectionExecute('welcome')(c);

    expect(opened).toBe(true);
  });
});
