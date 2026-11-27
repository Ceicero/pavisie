import { describe, expect, it } from 'vitest';
import { toQueryString } from '../src/lib/dashboard/api';

describe('toQueryString', () => {
  it('returns an empty string for an empty object', () => {
    expect(toQueryString({})).toBe('');
  });

  it('drops undefined, null, and empty-string values and omits those keys', () => {
    expect(toQueryString({ a: 'ok', b: undefined, c: null, d: '' })).toBe('?a=ok');
    expect(toQueryString({ b: undefined, c: null, d: '' })).toBe('');
  });

  it('keeps 0 and false, and stringifies numbers and booleans', () => {
    expect(toQueryString({ n: 0, flag: false })).toBe('?n=0&flag=false');
    expect(toQueryString({ n: 42, flag: true })).toBe('?n=42&flag=true');
  });

  it('prefixes a non-empty result with ?', () => {
    const qs = toQueryString({ cursor: 'abc', limit: 25 });
    expect(qs.startsWith('?')).toBe(true);
    expect(qs).toBe('?cursor=abc&limit=25');
  });
});
