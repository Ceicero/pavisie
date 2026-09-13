import { z } from 'zod';
import { defineManifest } from '../sdk';

export const configSchema = z.object({
  currencyName: z.string().trim().min(1).max(32).default('Agis'),
  currencySymbol: z.string().trim().min(1).max(8).default('♦️'),
  dailyMinAmount: z.number().int().min(0).max(1_000_000).default(50),
  dailyMaxAmount: z.number().int().min(0).max(1_000_000).default(150),
  streakBonusPerDay: z.number().int().min(0).max(10_000).default(10),
  streakBonusMax: z.number().int().min(0).max(1_000_000).default(200),
  giveMinAmount: z.number().int().min(1).max(1_000_000_000).default(1),
  giveMaxAmount: z.number().int().min(1).max(1_000_000_000).default(100_000),
});

export type EconomyConfig = z.infer<typeof configSchema>;

export const manifest = defineManifest({
  id: 'economy',
  name: 'Economy',
  description:
    'Optional virtual currency: balance, daily rewards with a streak bonus, giving between members, and a leaderboard. Virtual points only — no purchase, no cash-out, no gambling. Disabled by default.',
  category: 'community',
  version: '0.1.0',
  defaultEnabled: false,
  permissions: [],
  intents: [],
  requiredEnv: [],
  configSchema,
  privacyNotes: [
    'Every balance change is recorded as an append-only EconomyTransaction (who, amount, type, and an optional note) — balances themselves are a derived/cached total, never edited without a matching transaction.',
    'This currency has no real-world value: it cannot be purchased with real money, cashed out, transferred off-platform, or used for wagering of any kind.',
  ],
});
