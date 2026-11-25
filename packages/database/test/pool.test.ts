import { describe, expect, it } from 'vitest';
import { DEFAULT_POOL_SIZE, MAX_POOL_SIZE, parsePoolSize, withPoolDefaults } from '../src/pool';

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

  it('rejects an invalid DATABASE_POOL_SIZE even when the URL sets connection_limit or is missing', () => {
    expect(() => withPoolDefaults(`${BASE}?connection_limit=3`, 'ten')).toThrow(/DATABASE_POOL_SIZE/);
    expect(() => withPoolDefaults(undefined, '0')).toThrow(/DATABASE_POOL_SIZE/);
  });

  it('treats only the lowercase parameter (the one Prisma reads) as already set', () => {
    expect(withPoolDefaults(`${BASE}?Connection_Limit=3`, '4')).toBe(
      `${BASE}?Connection_Limit=3&connection_limit=4`,
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

  it('fills in an empty connection_limit instead of treating it as already set', () => {
    expect(withPoolDefaults(`${BASE}?connection_limit=`, '6')).toBe(`${BASE}?connection_limit=6`);
    expect(withPoolDefaults(`${BASE}?sslmode=require&connection_limit=&schema=public`, undefined)).toBe(
      `${BASE}?sslmode=require&connection_limit=${DEFAULT_POOL_SIZE}&schema=public`,
    );
    expect(withPoolDefaults(`${BASE}?connection_limit=#frag`, '6')).toBe(`${BASE}?connection_limit=6#frag`);
  });

  it('fills every empty connection_limit, not just the first', () => {
    expect(withPoolDefaults(`${BASE}?connection_limit=&connection_limit=`, '6')).toBe(
      `${BASE}?connection_limit=6&connection_limit=6`,
    );
  });

  it('trims surrounding whitespace before appending', () => {
    expect(withPoolDefaults(` ${BASE} \n`, '4')).toBe(`${BASE}?connection_limit=4`);
  });

  it('accepts the postgres:// scheme alias', () => {
    expect(withPoolDefaults('postgres://u:p@h:5432/db', '4')).toBe(
      'postgres://u:p@h:5432/db?connection_limit=4',
    );
  });

  it('leaves non-Postgres URLs such as Prisma Accelerate unchanged', () => {
    const accelerate = 'prisma://accelerate.prisma-data.net/?api_key=abc';
    expect(withPoolDefaults(accelerate, '4')).toBe(accelerate);
  });

  it('still validates DATABASE_POOL_SIZE for a non-Postgres URL', () => {
    expect(() => withPoolDefaults('prisma://accelerate.prisma-data.net/?api_key=abc', '0')).toThrow(
      /DATABASE_POOL_SIZE/,
    );
  });

  it('returns undefined for a missing or blank URL so Prisma reports it as before', () => {
    expect(withPoolDefaults(undefined, '5')).toBeUndefined();
    expect(withPoolDefaults('  ', undefined)).toBeUndefined();
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

  it('accepts the maximum and rejects anything above it', () => {
    expect(parsePoolSize(String(MAX_POOL_SIZE))).toBe(MAX_POOL_SIZE);
    expect(() => parsePoolSize(String(MAX_POOL_SIZE + 1))).toThrow(/no greater than 100/);
    expect(() => parsePoolSize('1000')).toThrow(/no greater than 100/);
  });

  it.each(['0', '-1', '2.5', '1e2', 'ten', '0x10', '999999'])('rejects %s', (raw) => {
    expect(() => parsePoolSize(raw)).toThrow(/DATABASE_POOL_SIZE must be a positive integer/);
  });
});
