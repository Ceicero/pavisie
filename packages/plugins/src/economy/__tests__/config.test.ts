import { describe, expect, it } from 'vitest';
import { command as economyCommand } from '../commands/economy';
import { configSchema } from '../manifest';
import { assertKnownConfigKeys } from '../../sdk/config-store';
import { buildFakeEconomyPrisma } from './fake-economy-prisma';
import { buildCommandContext, descriptionOf } from './command-context';

// The `twitch*` guild-config keys are gone: a streamer's Twitch currency is owned by the Twitch channel and configured
// on the creator dashboard (ARCHITECTURE.md §18b/§19e). These tests pin that removal AND that it is backward
// compatible — a guild whose stored config still carries the old keys must keep working.

const STALE_TWITCH_KEYS = {
  twitchEnabled: true,
  twitchEarnEnabled: true,
  twitchEarnPerMessage: 7,
  twitchEarnCooldownSeconds: 30,
  twitchEarnDailyCap: 90,
};

describe('economy config schema after the Twitch keys moved to the channel', () => {
  it('parses defaults without any twitch key', () => {
    const parsed = configSchema.parse({});
    expect(Object.keys(parsed).filter((k) => k.toLowerCase().includes('twitch'))).toEqual([]);
    expect(parsed).toMatchObject({ currencyName: 'Agis', dailyMinAmount: 50, giveMaxAmount: 100_000 });
  });

  it('stale stored twitch keys never break parsing: they are simply dropped, other settings survive', () => {
    const parsed = configSchema.parse({ currencyName: 'Coins', dailyMinAmount: 20, ...STALE_TWITCH_KEYS });
    expect(parsed.currencyName).toBe('Coins');
    expect(parsed.dailyMinAmount).toBe(20);
    expect(Object.keys(parsed).some((k) => k.startsWith('twitch'))).toBe(false);
  });

  it('even garbage in a stale twitch key cannot make a guild config unreadable', () => {
    expect(() => configSchema.parse({ twitchEarnPerMessage: 'lots', twitchEnabled: 'yes', twitchEarnDailyCap: -5 })).not.toThrow();
  });

  it('a NEW write of a twitch key is rejected as unknown (they no longer do anything)', () => {
    expect(() => assertKnownConfigKeys('economy', configSchema, { twitchEnabled: true })).toThrow(/Unknown config field/);
    expect(() => assertKnownConfigKeys('economy', configSchema, { currencyName: 'Coins' })).not.toThrow();
  });
});

describe('/economy config', () => {
  it('no longer offers any twitch-* option', () => {
    const json = economyCommand.data.toJSON();
    const config = json.options?.find((o) => o.name === 'config') as { options?: { name: string }[] } | undefined;
    expect(config).toBeDefined();
    const names = (config?.options ?? []).map((o) => o.name);
    expect(names).toEqual(['currency-name', 'currency-symbol', 'daily-min', 'daily-max', 'give-min', 'give-max']);
    expect(names.some((n) => n.startsWith('twitch'))).toBe(false);
  });

  it('still offers the leaderboard platform choices (global / discord / twitch)', () => {
    const json = economyCommand.data.toJSON();
    const board = json.options?.find((o) => o.name === 'leaderboard') as
      | { options?: { name: string; choices?: { value: string }[] }[] }
      | undefined;
    expect(board?.options?.[0]?.choices?.map((c) => c.value)).toEqual(['global', 'discord', 'twitch']);
  });

  it('the settings summary mentions no Twitch chat settings, even for a guild with stale twitch keys stored', async () => {
    const { prisma } = buildFakeEconomyPrisma([]);
    const { c, reply } = buildCommandContext(
      { sub: 'config' },
      'caller-1',
      prisma,
      configSchema.parse({ currencyName: 'Coins', currencySymbol: '🪙', ...STALE_TWITCH_KEYS }),
      { staffLevel: 'admin' },
    );
    await economyCommand.execute(c);
    const desc = descriptionOf(reply());
    expect(desc).toContain('Coins');
    expect(desc.toLowerCase()).not.toContain('twitch');
  });
});
