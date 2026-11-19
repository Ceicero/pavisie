/**
 * Coverage for `defaultForSchema` in `apps/web/src/lib/dashboard/json-schema.ts`.
 */
import { describe, expect, it } from 'vitest';
import { defaultForSchema, type JsonSchemaNode } from '../src/lib/dashboard/json-schema';

describe('defaultForSchema', () => {
  it('returns an explicit default, including falsy values', () => {
    expect(defaultForSchema({ type: 'number', default: 0 })).toBe(0);
    expect(defaultForSchema({ type: 'boolean', default: false })).toBe(false);
    expect(defaultForSchema({ type: 'string', default: '' })).toBe('');
    expect(defaultForSchema({ type: 'string', default: null })).toBeNull();
    expect(defaultForSchema({ type: 'string', default: 'stored' })).toBe('stored');
  });

  it('returns the first string enum value, or an empty string when the enum is missing or empty', () => {
    expect(defaultForSchema({ type: 'string', enum: ['alpha', 'beta'] })).toBe('alpha');
    expect(defaultForSchema({ type: 'string', enum: [] })).toBe('');
    expect(defaultForSchema({ type: 'string' })).toBe('');
  });

  it('returns the minimum for number and integer, or 0 when there is none', () => {
    expect(defaultForSchema({ type: 'number', minimum: 3 })).toBe(3);
    expect(defaultForSchema({ type: 'integer', minimum: -2 })).toBe(-2);
    expect(defaultForSchema({ type: 'number' })).toBe(0);
    expect(defaultForSchema({ type: 'integer' })).toBe(0);
    expect(defaultForSchema({ type: 'number', minimum: 0 })).toBe(0);
  });

  it('returns false for boolean', () => {
    expect(defaultForSchema({ type: 'boolean' })).toBe(false);
  });

  it('returns a new empty array for array and a new empty object for object on each call', () => {
    const firstArray = defaultForSchema({ type: 'array' });
    const secondArray = defaultForSchema({ type: 'array' });
    expect(firstArray).toEqual([]);
    expect(secondArray).toEqual([]);
    expect(firstArray).not.toBe(secondArray);

    const firstObject = defaultForSchema({ type: 'object' });
    const secondObject = defaultForSchema({ type: 'object' });
    expect(firstObject).toEqual({});
    expect(secondObject).toEqual({});
    expect(firstObject).not.toBe(secondObject);
  });

  it('returns null for a missing type when nullable, and an empty string otherwise', () => {
    expect(defaultForSchema({ nullable: true })).toBeNull();
    expect(defaultForSchema({} as JsonSchemaNode)).toBe('');
    expect(defaultForSchema({ type: undefined })).toBe('');
  });
});
