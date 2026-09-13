import { ValidationError } from '@pavisie/core';
import { describe, expect, it } from 'vitest';
import { validateIntakeAnswers } from '../intake';
import type { TicketIntakeField } from '../manifest';

const fields: TicketIntakeField[] = [
  { label: 'What do you need help with?', style: 'short', required: true },
  { label: 'Details', style: 'paragraph', required: false },
];

describe('validateIntakeAnswers', () => {
  it('passes when every required field has a non-empty answer', () => {
    expect(() =>
      validateIntakeAnswers(fields, { 'What do you need help with?': 'Billing', Details: '' }),
    ).not.toThrow();
  });

  it('throws ValidationError when a required field is missing entirely', () => {
    expect(() => validateIntakeAnswers(fields, { Details: 'x' })).toThrow(ValidationError);
  });

  it('throws ValidationError when a required field is present but only whitespace', () => {
    expect(() => validateIntakeAnswers(fields, { 'What do you need help with?': '   ' })).toThrow(
      ValidationError,
    );
  });

  it('does not require an optional field', () => {
    expect(() => validateIntakeAnswers(fields, { 'What do you need help with?': 'Billing' })).not.toThrow();
  });

  it('enforces the 200-char limit on short fields', () => {
    const longValue = 'a'.repeat(201);
    expect(() => validateIntakeAnswers(fields, { 'What do you need help with?': longValue })).toThrow(
      ValidationError,
    );
  });

  it('allows up to the 4000-char limit on paragraph fields', () => {
    const value = 'a'.repeat(4000);
    expect(() =>
      validateIntakeAnswers(fields, { 'What do you need help with?': 'x', Details: value }),
    ).not.toThrow();
  });

  it('rejects a paragraph field over the 4000-char limit', () => {
    const value = 'a'.repeat(4001);
    expect(() =>
      validateIntakeAnswers(fields, { 'What do you need help with?': 'x', Details: value }),
    ).toThrow(ValidationError);
  });

  it('is a no-op for an empty field list', () => {
    expect(() => validateIntakeAnswers([], {})).not.toThrow();
  });
});
