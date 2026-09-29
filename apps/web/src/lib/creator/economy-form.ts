// Pure form logic for the creator dashboard's "Currency" section (ARCHITECTURE.md §18b/§19e): field bounds, draft <->
// settings conversion, client-side validation and the minimal PATCH body. No React, no fetch — unit-tested directly
// (`apps/web/test/creator-economy-form.test.ts`, which also pins these bounds to the API's own schema so the two
// cannot drift). The API re-validates everything; this only gives instant feedback.
import type { CreatorChannelEconomySettingsDto } from '@pavisie/types/creator';

export type EconomyNumericField =
  | 'dailyMinAmount'
  | 'dailyMaxAmount'
  | 'streakBonusPerDay'
  | 'streakBonusMax'
  | 'giveMinAmount'
  | 'giveMaxAmount'
  | 'earnPerMessage'
  | 'earnCooldownSeconds'
  | 'earnDailyCap';

/** Mirrors `channelEconomySettingsSchema` in `packages/plugins/src/channel-economy/settings.ts`. */
export const ECONOMY_NUMERIC_FIELDS: Record<EconomyNumericField, { label: string; min: number; max: number }> = {
  dailyMinAmount: { label: 'Daily reward, minimum', min: 0, max: 1_000_000 },
  dailyMaxAmount: { label: 'Daily reward, maximum', min: 0, max: 1_000_000 },
  streakBonusPerDay: { label: 'Streak bonus per day', min: 0, max: 10_000 },
  streakBonusMax: { label: 'Streak bonus cap', min: 0, max: 1_000_000 },
  giveMinAmount: { label: 'Smallest !give', min: 1, max: 1_000_000_000 },
  giveMaxAmount: { label: 'Largest !give', min: 1, max: 1_000_000_000 },
  earnPerMessage: { label: 'Earned per message', min: 1, max: 1000 },
  earnCooldownSeconds: { label: 'Seconds between earns', min: 10, max: 3600 },
  earnDailyCap: { label: 'Daily earning cap per viewer', min: 0, max: 1_000_000 },
};

export const ECONOMY_NAME_MAX = 32;
export const ECONOMY_SYMBOL_MAX = 8;

export interface EconomyDraft {
  currencyName: string;
  currencySymbol: string;
  earnEnabled: boolean;
  /** Numbers are kept as the text the streamer typed, so an empty box can be shown (and flagged) while editing. */
  numbers: Record<EconomyNumericField, string>;
}

export function toDraft(settings: CreatorChannelEconomySettingsDto): EconomyDraft {
  const numbers = {} as Record<EconomyNumericField, string>;
  for (const field of Object.keys(ECONOMY_NUMERIC_FIELDS) as EconomyNumericField[]) {
    numbers[field] = String(settings[field]);
  }
  return {
    currencyName: settings.currencyName,
    currencySymbol: settings.currencySymbol,
    earnEnabled: settings.earnEnabled,
    numbers,
  };
}

/** `null` unless the text is a whole number (no fractions, no exponent, no blank). */
export function parseWholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

export type EconomyDraftErrors = Partial<Record<'currencyName' | 'currencySymbol' | EconomyNumericField, string>>;

/** Per-field problems, plus the two cross-field rules (a range's minimum cannot exceed its maximum). Empty = valid. */
export function validateDraft(draft: EconomyDraft): EconomyDraftErrors {
  const errors: EconomyDraftErrors = {};

  const name = draft.currencyName.trim();
  if (name.length === 0) errors.currencyName = 'Give your currency a name.';
  else if (name.length > ECONOMY_NAME_MAX) errors.currencyName = `At most ${ECONOMY_NAME_MAX} characters.`;

  const symbol = draft.currencySymbol.trim();
  if (symbol.length === 0) errors.currencySymbol = 'Pick a short symbol or emoji.';
  else if (symbol.length > ECONOMY_SYMBOL_MAX) errors.currencySymbol = `At most ${ECONOMY_SYMBOL_MAX} characters.`;

  const parsed: Partial<Record<EconomyNumericField, number>> = {};
  for (const [field, bounds] of Object.entries(ECONOMY_NUMERIC_FIELDS) as [EconomyNumericField, (typeof ECONOMY_NUMERIC_FIELDS)[EconomyNumericField]][]) {
    const value = parseWholeNumber(draft.numbers[field]);
    if (value === null) errors[field] = 'Enter a whole number.';
    else if (value < bounds.min || value > bounds.max) {
      errors[field] = `Between ${bounds.min.toLocaleString('en-US')} and ${bounds.max.toLocaleString('en-US')}.`;
    } else parsed[field] = value;
  }

  if (
    parsed.dailyMinAmount !== undefined &&
    parsed.dailyMaxAmount !== undefined &&
    parsed.dailyMinAmount > parsed.dailyMaxAmount &&
    !errors.dailyMinAmount
  ) {
    errors.dailyMinAmount = 'The minimum cannot be higher than the maximum.';
  }
  if (
    parsed.giveMinAmount !== undefined &&
    parsed.giveMaxAmount !== undefined &&
    parsed.giveMinAmount > parsed.giveMaxAmount &&
    !errors.giveMinAmount
  ) {
    errors.giveMinAmount = 'The minimum cannot be higher than the maximum.';
  }
  return errors;
}

/** Only what differs from the saved settings, parsed to real numbers — `{}` when nothing changed. Call only on a
 * valid draft. The master `enabled` switch is not part of the form (it saves on its own). */
export function buildPatch(
  saved: CreatorChannelEconomySettingsDto,
  draft: EconomyDraft,
): Partial<CreatorChannelEconomySettingsDto> {
  const patch: Partial<CreatorChannelEconomySettingsDto> = {};
  const name = draft.currencyName.trim();
  const symbol = draft.currencySymbol.trim();
  if (name !== saved.currencyName) patch.currencyName = name;
  if (symbol !== saved.currencySymbol) patch.currencySymbol = symbol;
  if (draft.earnEnabled !== saved.earnEnabled) patch.earnEnabled = draft.earnEnabled;
  for (const field of Object.keys(ECONOMY_NUMERIC_FIELDS) as EconomyNumericField[]) {
    const value = parseWholeNumber(draft.numbers[field]);
    if (value !== null && value !== saved[field]) patch[field] = value;
  }
  return patch;
}

/** Formats a decimal-string amount from the API (a bigint on the server) with thousands separators. */
export function formatAmount(value: string): string {
  try {
    return BigInt(value).toLocaleString('en-US');
  } catch {
    return value;
  }
}

export interface AdjustDraft {
  login: string;
  direction: 'add' | 'remove';
  amount: string;
  reason: string;
}

export const ADJUST_REASON_MAX = 200;
export const ADJUST_AMOUNT_MAX = 1_000_000_000;
const TWITCH_LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;

/** Mirrors the API's adjust body schema; returns the normalised request body, or the first problem. */
export function validateAdjust(
  draft: AdjustDraft,
): { ok: true; input: { login: string; direction: 'add' | 'remove'; amount: number; reason: string } } | { ok: false; error: string } {
  const login = draft.login.trim().replace(/^@/, '').toLowerCase();
  if (!TWITCH_LOGIN_PATTERN.test(login)) return { ok: false, error: "Enter the viewer's Twitch username." };
  const amount = parseWholeNumber(draft.amount);
  if (amount === null || amount < 1 || amount > ADJUST_AMOUNT_MAX) {
    return { ok: false, error: `Enter a whole number from 1 to ${ADJUST_AMOUNT_MAX.toLocaleString('en-US')}.` };
  }
  const reason = draft.reason.trim();
  if (reason.length === 0) return { ok: false, error: 'A reason is required.' };
  if (reason.length > ADJUST_REASON_MAX) return { ok: false, error: `The reason can be at most ${ADJUST_REASON_MAX} characters.` };
  return { ok: true, input: { login, direction: draft.direction, amount, reason } };
}
