import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configSchema } from '../manifest';

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
      expect(giveaways._def.defaultValue()).toEqual({ defaultWinners: 1 });
      expect(polls._def.defaultValue()).toEqual({ maxOptions: 10 });
      expect(suggestions._def.defaultValue()).toMatchObject({ threads: true, dmAuthorOnStatus: true });
    }
  });

  it('does not share the event reminder default array across reads', () => {
    const field = configSchema.shape.eventReminderMinutes;
    expect(field).toBeInstanceOf(z.ZodDefault);
    if (field instanceof z.ZodDefault) {
      const first = field._def.defaultValue() as number[];
      first.push(5);
      expect(field._def.defaultValue()).toEqual([60, 10]);
    }
  });
});
