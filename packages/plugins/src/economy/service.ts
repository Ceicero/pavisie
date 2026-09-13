// Pure business logic for the economy plugin — no discord.js/Prisma imports (ARCHITECTURE.md §13). Virtual
// currency only: no purchase, no cash-out, no gambling (SPEC.md §G).

export const DAILY_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20h
export const STREAK_CONTINUES_WITHIN_MS = 48 * 60 * 60 * 1000; // claiming again within 48h keeps the streak alive

export interface RollDailyConfig {
  dailyMinAmount: number;
  dailyMaxAmount: number;
  streakBonusPerDay: number;
  streakBonusMax: number;
}

export interface RollDailyInput {
  now: Date;
  lastDailyAt: Date | null;
  /** The streak count going into this claim (0 if there is none, e.g. a first-ever claim or a broken streak). */
  priorStreak: number;
  config: RollDailyConfig;
  /** Returns a value in `[0, 1)`; inject `Math.random` in production, a fixed value in tests for determinism. */
  rng: () => number;
}

export type RollDailyResult =
  { ok: true; amount: number; streak: number } | { ok: false; retryAfterMs: number };

/**
 * Rolls a `/economy daily` claim: enforces the 20h cooldown, extends the streak when claimed within 48h of the
 * last claim (otherwise resets it to 1), and computes a random base amount plus a streak bonus capped at
 * `streakBonusMax`.
 */
export function rollDaily(input: RollDailyInput): RollDailyResult {
  const { now, lastDailyAt, priorStreak, config, rng } = input;

  if (lastDailyAt) {
    const elapsed = now.getTime() - lastDailyAt.getTime();
    if (elapsed < DAILY_COOLDOWN_MS) {
      return { ok: false, retryAfterMs: DAILY_COOLDOWN_MS - elapsed };
    }
  }

  const streakContinues =
    lastDailyAt !== null && now.getTime() - lastDailyAt.getTime() <= STREAK_CONTINUES_WITHIN_MS;
  const streak = streakContinues ? priorStreak + 1 : 1;

  const range = Math.max(0, config.dailyMaxAmount - config.dailyMinAmount);
  const base = config.dailyMinAmount + Math.floor(rng() * (range + 1));
  const bonus = Math.min(config.streakBonusMax, streak * config.streakBonusPerDay);

  return { ok: true, amount: base + bonus, streak };
}

/** Recovers the streak count recorded on the most recent daily-claim transaction's `note` field (`{"streak":n}`), defaulting to 0 when absent or malformed. */
export function parseStreakFromNote(note: string | null | undefined): number {
  if (!note) return 0;
  try {
    const parsed: unknown = JSON.parse(note);
    if (parsed && typeof parsed === 'object' && 'streak' in parsed) {
      const value = (parsed as { streak: unknown }).streak;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Encodes a streak count into the transaction-note format `parseStreakFromNote` reads back. */
export function encodeStreakNote(streak: number): string {
  return JSON.stringify({ streak });
}

export interface GiveConfig {
  giveMinAmount: number;
  giveMaxAmount: number;
}

export type GiveValidationResult =
  { ok: true } | { ok: false; reason: 'self' | 'bot' | 'below_min' | 'above_max' | 'insufficient_balance' };

export interface ValidateGiveInput {
  amount: number;
  senderBalance: bigint;
  config: GiveConfig;
  targetIsSelf: boolean;
  targetIsBot: boolean;
}

/** Validates a `/economy give` before any balance is touched. */
export function validateGive(input: ValidateGiveInput): GiveValidationResult {
  const { amount, senderBalance, config, targetIsSelf, targetIsBot } = input;

  if (targetIsSelf) return { ok: false, reason: 'self' };
  if (targetIsBot) return { ok: false, reason: 'bot' };
  if (amount < config.giveMinAmount) return { ok: false, reason: 'below_min' };
  if (amount > config.giveMaxAmount) return { ok: false, reason: 'above_max' };
  if (BigInt(amount) > senderBalance) return { ok: false, reason: 'insufficient_balance' };

  return { ok: true };
}

/** Formats a balance with the guild's configured currency name/symbol, e.g. `"1,234 ♦️ Agis"`. */
export function formatCurrency(amount: bigint, symbol: string): string {
  return `${amount.toLocaleString('en-US')} ${symbol}`;
}
