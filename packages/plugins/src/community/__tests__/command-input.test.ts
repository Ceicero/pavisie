import { describe, expect, it } from 'vitest';
import {
  duplicateOptionLabels,
  durationIssue,
  isInThePast,
  isMissingChannelPermission,
  MAX_OPEN_MS,
  MIN_OPEN_MS,
  nonBlank,
} from '../command-input';

describe('community command input', () => {
  it('rejects blank text and keeps a trimmed value', () => {
    expect(nonBlank('   ')).toBeNull();
    expect(nonBlank('  hello  ')).toBe('hello');
  });

  it('flags durations outside 15 seconds to 28 days', () => {
    expect(durationIssue(null)).toBe('invalid');
    expect(durationIssue(0)).toBe('invalid');
    expect(durationIssue(MIN_OPEN_MS - 1)).toBe('range');
    expect(durationIssue(MIN_OPEN_MS)).toBeNull();
    expect(durationIssue(MAX_OPEN_MS)).toBeNull();
    expect(durationIssue(MAX_OPEN_MS + 1)).toBe('range');
  });

  it('treats a time more than 30 seconds ago as in the past', () => {
    const now = Date.parse('2026-06-01T12:00:00Z');
    expect(isInThePast(new Date(now - 60_000), now)).toBe(true);
    expect(isInThePast(new Date(now - 5_000), now)).toBe(false);
    expect(isInThePast(new Date(now + 60_000), now)).toBe(false);
  });

  it('lists case-insensitive duplicate option labels in first-seen order', () => {
    expect(duplicateOptionLabels(['Yes', 'No', 'yes'])).toEqual(['Yes', 'yes']);
    expect(duplicateOptionLabels(['A', 'B'])).toEqual([]);
  });

  it('recognizes Discord missing-access and missing-permissions errors', () => {
    expect(isMissingChannelPermission(Object.assign(new Error('nope'), { code: 50013 }))).toBe(true);
    expect(isMissingChannelPermission(Object.assign(new Error('nope'), { code: 50001 }))).toBe(true);
    expect(isMissingChannelPermission(new Error('network'))).toBe(false);
    expect(isMissingChannelPermission(null)).toBe(false);
  });
});
