import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configSchema } from '../manifest';

/** zod 4 exposes `_def.defaultValue` as a getter (zod 3: a function); read it either way. */
function defaultOf(schema: z.ZodDefault): unknown {
  const value = (schema._def as { defaultValue: unknown }).defaultValue;
  return typeof value === 'function' ? (value as () => unknown)() : value;
}

describe('community config object defaults', () => {
  it('fills nested giveaway, poll, and suggestion defaults from an empty config', () => {
    const config = configSchema.parse({});
    expect(config.giveaways.defaultWinners).toBe(1);
    expect(config.polls.maxOptions).toBe(10);
    expect(config.suggestions).toMatchObject({ channelId: null, threads: true, dmAuthorOnStatus: true });
    expect(config.eventReminderMinutes).toEqual([60, 10]);
  });

  it('publishes those nested defaults instead of a bare empty object', () => {
    const giveaways = configSchema.shape.giveaways;
    const polls = configSchema.shape.polls;
    const suggestions = configSchema.shape.suggestions;
    expect(giveaways).toBeInstanceOf(z.ZodDefault);
    expect(polls).toBeInstanceOf(z.ZodDefault);
    expect(suggestions).toBeInstanceOf(z.ZodDefault);
    if (
      giveaways instanceof z.ZodDefault &&
      polls instanceof z.ZodDefault &&
      suggestions instanceof z.ZodDefault
    ) {
      expect(defaultOf(giveaways)).toEqual({ defaultWinners: 1 });
      expect(defaultOf(polls)).toEqual({ maxOptions: 10 });
      expect(defaultOf(suggestions)).toMatchObject({ threads: true, dmAuthorOnStatus: true });
    }
  });

  it('does not share the event reminder default array across reads', () => {
    const field = configSchema.shape.eventReminderMinutes;
    expect(field).toBeInstanceOf(z.ZodDefault);
    if (field instanceof z.ZodDefault) {
      const first = defaultOf(field) as number[];
      first.push(5);
      expect(defaultOf(field)).toEqual([60, 10]);
    }
  });
});
