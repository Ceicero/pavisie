import { describe, expect, it } from 'vitest';
import type { CreatorChannelEconomySettingsDto } from '@pavisie/types/creator';
import {
  ECONOMY_NAME_MAX,
  ECONOMY_NUMERIC_FIELDS,
  ECONOMY_SYMBOL_MAX,
  buildPatch,
  formatAmount,
  parseWholeNumber,
  toDraft,
  validateAdjust,
  validateDraft,
  type EconomyNumericField,
} from '../src/lib/creator/economy-form';
// The API's own schema — the source of truth the form's client-side limits must match (imported by relative path
// because the web app does not depend on the plugins package at runtime; this is a test-only cross-check).
import {
  CHANNEL_ECONOMY_DEFAULTS,
  channelEconomySettingsSchema,
} from '../../../packages/plugins/src/channel-economy/settings';

const SAVED: CreatorChannelEconomySettingsDto = { ...CHANNEL_ECONOMY_DEFAULTS, enabled: true };

describe('creator currency form — limits match the API schema exactly', () => {
  for (const field of Object.keys(ECONOMY_NUMERIC_FIELDS) as EconomyNumericField[]) {
    const { min, max } = ECONOMY_NUMERIC_FIELDS[field];
    it(`${field}: accepts ${min} and ${max}, rejects ${min - 1} and ${max + 1}`, () => {
      const parse = (value: number) => channelEconomySettingsSchema.safeParse({ ...SAVED, [field]: value }).success;
      expect(parse(min)).toBe(true);
      expect(parse(max)).toBe(true);
      expect(parse(min - 1)).toBe(false);
      expect(parse(max + 1)).toBe(false);
    });
  }

  it('the name and symbol limits match too', () => {
    const parse = (patch: object) => channelEconomySettingsSchema.safeParse({ ...SAVED, ...patch }).success;
    expect(parse({ currencyName: 'x'.repeat(ECONOMY_NAME_MAX) })).toBe(true);
    expect(parse({ currencyName: 'x'.repeat(ECONOMY_NAME_MAX + 1) })).toBe(false);
    expect(parse({ currencySymbol: 'x'.repeat(ECONOMY_SYMBOL_MAX) })).toBe(true);
    expect(parse({ currencySymbol: 'x'.repeat(ECONOMY_SYMBOL_MAX + 1) })).toBe(false);
  });

  it('covers every numeric setting the API has (none silently missing from the form)', () => {
    const apiNumeric = Object.keys(CHANNEL_ECONOMY_DEFAULTS).filter(
      (k) => typeof (CHANNEL_ECONOMY_DEFAULTS as unknown as Record<string, unknown>)[k] === 'number',
    );
    expect(Object.keys(ECONOMY_NUMERIC_FIELDS).sort()).toEqual(apiNumeric.sort());
  });
});

describe('parseWholeNumber', () => {
  it('accepts plain non-negative whole numbers only', () => {
    expect(parseWholeNumber('42')).toBe(42);
    expect(parseWholeNumber(' 7 ')).toBe(7);
    expect(parseWholeNumber('0')).toBe(0);
    for (const bad of ['', ' ', '-1', '1.5', '1e3', 'abc', '12abc', '99999999999999999999']) {
      expect(parseWholeNumber(bad), bad).toBeNull();
    }
  });
});

describe('validateDraft', () => {
  it('the saved defaults are a valid draft', () => {
    expect(validateDraft(toDraft(SAVED))).toEqual({});
  });

  it('flags a blank/over-long name and symbol', () => {
    const draft = toDraft(SAVED);
    expect(validateDraft({ ...draft, currencyName: '  ' }).currencyName).toBeDefined();
    expect(validateDraft({ ...draft, currencyName: 'x'.repeat(33) }).currencyName).toBeDefined();
    expect(validateDraft({ ...draft, currencySymbol: '' }).currencySymbol).toBeDefined();
    expect(validateDraft({ ...draft, currencySymbol: 'x'.repeat(9) }).currencySymbol).toBeDefined();
  });

  it('flags blank, fractional and out-of-range numbers per field', () => {
    const draft = toDraft(SAVED);
    const withField = (field: EconomyNumericField, text: string) =>
      validateDraft({ ...draft, numbers: { ...draft.numbers, [field]: text } })[field];
    expect(withField('earnPerMessage', '')).toBeDefined();
    expect(withField('earnPerMessage', '1.5')).toBeDefined();
    expect(withField('earnPerMessage', '0')).toBeDefined();
    expect(withField('earnPerMessage', '1001')).toBeDefined();
    expect(withField('earnPerMessage', '1000')).toBeUndefined();
    expect(withField('earnDailyCap', '0')).toBeUndefined();
  });

  it('flags an inverted daily range and an inverted give range', () => {
    const draft = toDraft(SAVED);
    const daily = validateDraft({ ...draft, numbers: { ...draft.numbers, dailyMinAmount: '500', dailyMaxAmount: '100' } });
    expect(daily.dailyMinAmount).toMatch(/minimum/i);
    const give = validateDraft({ ...draft, numbers: { ...draft.numbers, giveMinAmount: '50', giveMaxAmount: '10' } });
    expect(give.giveMinAmount).toMatch(/minimum/i);
  });
});

describe('buildPatch', () => {
  it('is empty when nothing changed', () => {
    expect(buildPatch(SAVED, toDraft(SAVED))).toEqual({});
  });

  it('contains only what changed, as real numbers, trimmed', () => {
    const draft = toDraft(SAVED);
    draft.currencyName = '  Gems ';
    draft.earnEnabled = true;
    draft.numbers.earnPerMessage = '9';
    draft.numbers.dailyMaxAmount = String(SAVED.dailyMaxAmount); // unchanged -> omitted
    expect(buildPatch(SAVED, draft)).toEqual({ currencyName: 'Gems', earnEnabled: true, earnPerMessage: 9 });
  });

  it('never includes the master enabled switch (it saves on its own)', () => {
    expect(Object.keys(buildPatch({ ...SAVED, enabled: false }, toDraft({ ...SAVED, enabled: true })))).not.toContain('enabled');
  });
});

describe('validateAdjust', () => {
  const good = { login: '@SomeViewer', direction: 'add' as const, amount: '250', reason: ' giveaway ' };

  it('normalises a valid request (login lowercased without @, reason trimmed)', () => {
    expect(validateAdjust(good)).toEqual({
      ok: true,
      input: { login: 'someviewer', direction: 'add', amount: 250, reason: 'giveaway' },
    });
  });

  it('rejects an invalid login (URL, spaces, punctuation, too long, empty)', () => {
    for (const login of ['https://evil.example/x', 'two words', 'dot.name', 'a'.repeat(26), '', '@']) {
      expect(validateAdjust({ ...good, login }).ok, login).toBe(false);
    }
  });

  it('rejects bad amounts and a missing/blank/over-long reason', () => {
    for (const amount of ['', '0', '-3', '1.5', 'abc', '1000000001']) {
      expect(validateAdjust({ ...good, amount }).ok, amount).toBe(false);
    }
    for (const reason of ['', '   ', 'x'.repeat(201)]) {
      expect(validateAdjust({ ...good, reason }).ok, reason).toBe(false);
    }
    expect(validateAdjust({ ...good, direction: 'remove' }).ok).toBe(true);
  });
});

describe('formatAmount', () => {
  it('formats a decimal-string bigint with thousands separators, and survives values beyond 2^53', () => {
    expect(formatAmount('1234567')).toBe('1,234,567');
    expect(formatAmount('12345678901234567890')).toBe('12,345,678,901,234,567,890');
    expect(formatAmount('not a number')).toBe('not a number');
  });
});
