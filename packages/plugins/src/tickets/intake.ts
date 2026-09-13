// Pure, unit-tested: validates intake-form answers against the panel's configured questions.
import { ValidationError } from '@pavisie/core';
import type { TicketIntakeField } from './manifest';

const SHORT_MAX = 200;
const PARAGRAPH_MAX = 4000;

/** Throws `ValidationError` if `answers` (keyed by field label) doesn't satisfy `fields`' required/length rules. */
export function validateIntakeAnswers(fields: TicketIntakeField[], answers: Record<string, string>): void {
  for (const field of fields) {
    const value = answers[field.label];
    if (field.required && (value === undefined || value.trim().length === 0)) {
      throw new ValidationError(`"${field.label}" is required.`);
    }
    if (value === undefined) continue;
    const maxLen = field.style === 'paragraph' ? PARAGRAPH_MAX : SHORT_MAX;
    if (value.length > maxLen) {
      throw new ValidationError(`"${field.label}" must be ${maxLen} characters or fewer.`);
    }
  }
}
