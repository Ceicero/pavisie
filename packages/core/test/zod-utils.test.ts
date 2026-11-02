import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { partialWithoutDefaults } from '../src/zod-utils';

const base = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  limit: z.number().nullable().prefault(null),
});

describe('partialWithoutDefaults', () => {
  it('leaves omitted keys omitted (no defaults filled in)', () => {
    expect(partialWithoutDefaults(base).parse({ name: 'x' })).toEqual({ name: 'x' });
    expect(partialWithoutDefaults(base).parse({})).toEqual({});
  });
  it('still validates provided keys', () => {
    expect(partialWithoutDefaults(base).parse({ enabled: false, tags: ['a'] })).toEqual({
      enabled: false,
      tags: ['a'],
    });
    expect(() => partialWithoutDefaults(base).parse({ enabled: 'no' })).toThrow();
  });
  it('differs from zod 4 .partial(), which fills defaults', () => {
    expect(base.partial().parse({})).toMatchObject({ enabled: true, tags: [] });
  });
});
