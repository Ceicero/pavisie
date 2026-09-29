import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../economy/manifest';
import {
  CHANNEL_ECONOMY_DEFAULTS,
  channelEconomySettingsSchema,
  findChannelEconomySettingsProblem,
  pickChannelEconomySettings,
  toGiveConfig,
  toRollDailyConfig,
  updateChannelEconomySettingsSchema,
} from '../settings';

describe('channel economy settings', () => {
  it('the defaults are valid and match the guild economy plugin defaults for every shared field', () => {
    expect(channelEconomySettingsSchema.parse(CHANNEL_ECONOMY_DEFAULTS)).toEqual(CHANNEL_ECONOMY_DEFAULTS);
    const guild = configSchema.parse({});
    expect(CHANNEL_ECONOMY_DEFAULTS).toMatchObject({
      currencyName: guild.currencyName,
      currencySymbol: guild.currencySymbol,
      dailyMinAmount: guild.dailyMinAmount,
      dailyMaxAmount: guild.dailyMaxAmount,
      streakBonusPerDay: guild.streakBonusPerDay,
      streakBonusMax: guild.streakBonusMax,
      giveMinAmount: guild.giveMinAmount,
      giveMaxAmount: guild.giveMaxAmount,
    });
  });

  it('a new channel currency is off by default', () => {
    expect(CHANNEL_ECONOMY_DEFAULTS.enabled).toBe(false);
    expect(CHANNEL_ECONOMY_DEFAULTS.earnEnabled).toBe(false);
  });

  it('enforces the same bounds as the guild economy config', () => {
    const bad: Array<Record<string, unknown>> = [
      { currencyName: '' },
      { currencyName: 'x'.repeat(33) },
      { currencySymbol: 'x'.repeat(9) },
      { dailyMinAmount: -1 },
      { dailyMaxAmount: 1_000_001 },
      { streakBonusPerDay: 10_001 },
      { streakBonusMax: -1 },
      { giveMinAmount: 0 },
      { giveMaxAmount: 1_000_000_001 },
      { earnPerMessage: 0 },
      { earnPerMessage: 1001 },
      { earnCooldownSeconds: 9 },
      { earnCooldownSeconds: 3601 },
      { earnDailyCap: -1 },
      { earnDailyCap: 1_000_001 },
      { dailyMinAmount: 1.5 },
    ];
    for (const patch of bad) {
      expect(updateChannelEconomySettingsSchema.safeParse(patch).success, JSON.stringify(patch)).toBe(false);
    }
    expect(updateChannelEconomySettingsSchema.safeParse({ earnDailyCap: 0, dailyMinAmount: 0 }).success).toBe(true);
  });

  it('a patch is partial but strict: unknown keys are rejected, not ignored', () => {
    expect(updateChannelEconomySettingsSchema.safeParse({}).success).toBe(true);
    expect(updateChannelEconomySettingsSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(updateChannelEconomySettingsSchema.safeParse({ enabled: true, economyId: 'x' }).success).toBe(false);
    expect(updateChannelEconomySettingsSchema.safeParse({ platform: 'TWITCH' }).success).toBe(false);
  });

  it('trims the currency name and symbol', () => {
    expect(updateChannelEconomySettingsSchema.parse({ currencyName: '  Gems ', currencySymbol: ' 💎 ' })).toEqual({
      currencyName: 'Gems',
      currencySymbol: '💎',
    });
  });

  it('flags an inverted min/max range', () => {
    expect(findChannelEconomySettingsProblem(CHANNEL_ECONOMY_DEFAULTS)).toBeNull();
    expect(findChannelEconomySettingsProblem({ ...CHANNEL_ECONOMY_DEFAULTS, dailyMinAmount: 200, dailyMaxAmount: 100 })).toMatch(/daily/i);
    expect(findChannelEconomySettingsProblem({ ...CHANNEL_ECONOMY_DEFAULTS, giveMinAmount: 50, giveMaxAmount: 10 })).toMatch(/give/i);
  });

  it('pickChannelEconomySettings returns only the settings fields', () => {
    const row = { ...CHANNEL_ECONOMY_DEFAULTS, id: 'x', channelUserId: '1', createdAt: new Date() };
    expect(Object.keys(pickChannelEconomySettings(row)).sort()).toEqual(Object.keys(CHANNEL_ECONOMY_DEFAULTS).sort());
  });

  it('maps to the pure daily/give configs the shared rules take', () => {
    expect(toRollDailyConfig(CHANNEL_ECONOMY_DEFAULTS)).toEqual({ dailyMinAmount: 50, dailyMaxAmount: 150, streakBonusPerDay: 10, streakBonusMax: 200 });
    expect(toGiveConfig(CHANNEL_ECONOMY_DEFAULTS)).toEqual({ giveMinAmount: 1, giveMaxAmount: 100_000 });
  });
});

describe('channel economy settings vs the database model', () => {
  it('CHANNEL_ECONOMY_DEFAULTS equals the ChannelEconomy column defaults in schema.prisma (and so migration 0015)', () => {
    const schema = readFileSync(fileURLToPath(new URL('../../../../database/prisma/schema.prisma', import.meta.url)), 'utf8');
    const body = /model\s+ChannelEconomy\s*\{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
    for (const [field, value] of Object.entries(CHANNEL_ECONOMY_DEFAULTS)) {
      const declared = new RegExp(String.raw`^\s*${field}\s+\S+\s+@default\(([^)]*)\)`, 'm').exec(body)?.[1];
      expect(declared, field).toBeDefined();
      expect(declared, field).toBe(typeof value === 'string' ? JSON.stringify(value) : String(value));
    }
  });
});
