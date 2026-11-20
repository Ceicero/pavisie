import { describe, expect, it } from 'vitest';
import { DEFAULT_POOL_SIZE, parsePoolSize, withPoolDefaults } from '../src/pool';

const BASE = 'postgresql://pavisie:pa%40ss@db.internal:5432/pavisie';

describe('withPoolDefaults', () => {
  it('adds the default connection_limit when the URL has no query string', () => {
    expect(withPoolDefaults(BASE, undefined)).toBe(`${BASE}?connection_limit=${DEFAULT_POOL_SIZE}`);
  });

  it('appends to an existing query string without touching other parameters', () => {
    expect(withPoolDefaults(`${BASE}?sslmode=require&schema=public`, undefined)).toBe(
      `${BASE}?sslmode=require&schema=public&connection_limit=${DEFAULT_POOL_SIZE}`,
    );
  });

  it('does not add a stray separator after a trailing ? or &', () => {
    expect(withPoolDefaults(`${BASE}?`, '5')).toBe(`${BASE}?connection_limit=5`);
    expect(withPoolDefaults(`${BASE}?sslmode=require&`, '5')).toBe(
      `${BASE}?sslmode=require&connection_limit=5`,
    );
  });

  it('keeps a connection_limit already in the URL, even when DATABASE_POOL_SIZE is set', () => {
    expect(withPoolDefaults(`${BASE}?connection_limit=3`, '25')).toBe(`${BASE}?connection_limit=3`);
    expect(withPoolDefaults(`${BASE}?sslmode=require&connection_limit=3`, undefined)).toBe(
      `${BASE}?sslmode=require&connection_limit=3`,
    );
  });

  it('does not mistake a similarly named parameter for connection_limit', () => {
    expect(withPoolDefaults(`${BASE}?x_connection_limit=3`, undefined)).toBe(
      `${BASE}?x_connection_limit=3&connection_limit=${DEFAULT_POOL_SIZE}`,
    );
  });

  it('uses DATABASE_POOL_SIZE in place of the default', () => {
    expect(withPoolDefaults(BASE, '25')).toBe(`${BASE}?connection_limit=25`);
  });

  it('keeps percent-encoded credentials byte-for-byte', () => {
    expect(withPoolDefaults(BASE, undefined)?.startsWith(BASE)).toBe(true);
  });

  it('inserts the parameter before a fragment', () => {
    expect(withPoolDefaults(`${BASE}#frag`, '4')).toBe(`${BASE}?connection_limit=4#frag`);
  });

  it('returns undefined for a missing or blank URL so Prisma reports it as before', () => {
    expect(withPoolDefaults(undefined, '5')).toBeUndefined();
    expect(withPoolDefaults('  ', '5')).toBeUndefined();
  });
});

describe('parsePoolSize', () => {
  it('defaults when unset or blank', () => {
    expect(parsePoolSize(undefined)).toBe(DEFAULT_POOL_SIZE);
    expect(parsePoolSize('')).toBe(DEFAULT_POOL_SIZE);
    expect(parsePoolSize('  ')).toBe(DEFAULT_POOL_SIZE);
  });

  it('accepts a positive integer, ignoring surrounding whitespace', () => {
    expect(parsePoolSize(' 20 ')).toBe(20);
  });

  it.each(['0', '-1', '2.5', '1e2', 'ten', '0x10'])('rejects %s', (raw) => {
    expect(() => parsePoolSize(raw)).toThrow(/DATABASE_POOL_SIZE must be a positive integer/);
  });
});
