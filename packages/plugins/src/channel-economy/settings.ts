// Settings for a streaming channel's OWN virtual currency (`ChannelEconomy`, ARCHITECTURE.md §18b/§19e). Pure — no
// Prisma/discord.js imports — so the creator API, the Twitch chat runtime and the tests all share one definition.
//
// Every bound mirrors the guild economy plugin's `configSchema` (`economy/manifest.ts`) for the fields both have, so
// a currency behaves the same whether a Discord server or a streamer owns it. Virtual currency only: no purchase,
// no cash-out, no wagering (SPEC.md §G).
import { z } from 'zod';
import type { GiveConfig, RollDailyConfig } from '../economy/service';

export const channelEconomySettingsSchema = z.object({
  /** Master switch: the chat commands (!balance/!daily/!give/!top) and the extension panel only work when true. */
  enabled: z.boolean(),
  currencyName: z.string().trim().min(1).max(32),
  currencySymbol: z.string().trim().min(1).max(8),
  dailyMinAmount: z.number().int().min(0).max(1_000_000),
  dailyMaxAmount: z.number().int().min(0).max(1_000_000),
  streakBonusPerDay: z.number().int().min(0).max(10_000),
  streakBonusMax: z.number().int().min(0).max(1_000_000),
  giveMinAmount: z.number().int().min(1).max(1_000_000_000),
  giveMaxAmount: z.number().int().min(1).max(1_000_000_000),
  /** Award currency for chatting while the stream is live (independent of `enabled`'s commands, but the whole
   * economy must be `enabled` for earning to run). */
  earnEnabled: z.boolean(),
  earnPerMessage: z.number().int().min(1).max(1000),
  earnCooldownSeconds: z.number().int().min(10).max(3600),
  /** Max currency one viewer can earn from chat per UTC day (0 = no earning). */
  earnDailyCap: z.number().int().min(0).max(1_000_000),
});

export type ChannelEconomySettings = z.infer<typeof channelEconomySettingsSchema>;

/** What a brand-new channel economy starts with — the same numbers the guild economy plugin defaults to, and the
 * same values the `ChannelEconomy` column defaults / migration 0015's fallbacks use. Off until the streamer
 * turns it on. */
export const CHANNEL_ECONOMY_DEFAULTS: ChannelEconomySettings = {
  enabled: false,
  currencyName: 'Agis',
  currencySymbol: '♦️',
  dailyMinAmount: 50,
  dailyMaxAmount: 150,
  streakBonusPerDay: 10,
  streakBonusMax: 200,
  giveMinAmount: 1,
  giveMaxAmount: 100_000,
  earnEnabled: false,
  earnPerMessage: 5,
  earnCooldownSeconds: 60,
  earnDailyCap: 200,
};

/** A partial update: every field optional, unknown keys rejected (a typo must be a 400, never a silent no-op). */
export const updateChannelEconomySettingsSchema = channelEconomySettingsSchema.partial().strict();
export type UpdateChannelEconomySettings = z.infer<typeof updateChannelEconomySettingsSchema>;

/** The settings-shaped subset of a `ChannelEconomy` row (or any object carrying those fields). */
export function pickChannelEconomySettings(row: ChannelEconomySettings): ChannelEconomySettings {
  return {
    enabled: row.enabled,
    currencyName: row.currencyName,
    currencySymbol: row.currencySymbol,
    dailyMinAmount: row.dailyMinAmount,
    dailyMaxAmount: row.dailyMaxAmount,
    streakBonusPerDay: row.streakBonusPerDay,
    streakBonusMax: row.streakBonusMax,
    giveMinAmount: row.giveMinAmount,
    giveMaxAmount: row.giveMaxAmount,
    earnEnabled: row.earnEnabled,
    earnPerMessage: row.earnPerMessage,
    earnCooldownSeconds: row.earnCooldownSeconds,
    earnDailyCap: row.earnDailyCap,
  };
}

/** Cross-field rule a per-field schema cannot express: a range's minimum must not exceed its maximum. Returns a
 * human-readable problem, or `null` when the (merged) settings are coherent. */
export function findChannelEconomySettingsProblem(settings: ChannelEconomySettings): string | null {
  if (settings.dailyMinAmount > settings.dailyMaxAmount) {
    return 'The daily reward minimum cannot be higher than the maximum.';
  }
  if (settings.giveMinAmount > settings.giveMaxAmount) {
    return 'The minimum give amount cannot be higher than the maximum.';
  }
  return null;
}

export function toRollDailyConfig(settings: ChannelEconomySettings): RollDailyConfig {
  return {
    dailyMinAmount: settings.dailyMinAmount,
    dailyMaxAmount: settings.dailyMaxAmount,
    streakBonusPerDay: settings.streakBonusPerDay,
    streakBonusMax: settings.streakBonusMax,
  };
}

export function toGiveConfig(settings: ChannelEconomySettings): GiveConfig {
  return { giveMinAmount: settings.giveMinAmount, giveMaxAmount: settings.giveMaxAmount };
}
