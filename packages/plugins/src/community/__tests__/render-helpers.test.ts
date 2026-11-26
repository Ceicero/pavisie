import { describe, expect, it } from 'vitest';
import { discordTimestamp } from '@pavisie/core';
import type { CommunityEvent, EventRsvp, Poll, PollOption, PollVote } from '@pavisie/database';
import en from '../locales/en.json';
import { buildEventEmbed, buildPollEmbed, summarizeRsvps, tallyPollFromRows } from '../render';

/** Same bundle walk the giveaway embed tests use, so these assertions follow the English locale file. */
function realT(key: string, vars?: Record<string, string | number>): string {
  const parts = key.split('.');
  let node: unknown = en;
  for (const part of parts) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }
  if (typeof node !== 'string') return key;
  let out = node;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, String(value));
  }
  return out;
}

const WHEN = new Date('2026-11-23T19:00:00.000Z');

function poll(partial: Partial<Poll> = {}): Poll {
  return {
    id: 'poll-render-helpers',
    guildId: 'guild-render-helpers',
    channelId: 'ch-render-helpers',
    messageId: 'msg-render-helpers',
    question: 'Ship it?',
    anonymous: false,
    multiSelect: false,
    endsAt: null,
    closed: false,
    createdBy: 'user-host',
    createdAt: WHEN,
    updatedAt: WHEN,
    ...partial,
  } as Poll;
}

function option(partial: Pick<PollOption, 'id' | 'label' | 'position'> & Partial<PollOption>): PollOption {
  return {
    pollId: 'poll-render-helpers',
    emoji: null,
    ...partial,
  } as PollOption;
}

function vote(partial: Pick<PollVote, 'optionId' | 'userId'> & Partial<PollVote>): PollVote {
  return {
    id: `vote-${partial.userId}-${partial.optionId}`,
    pollId: 'poll-render-helpers',
    createdAt: WHEN,
    ...partial,
  } as PollVote;
}

function rsvp(status: EventRsvp['status'], userId: string): EventRsvp {
  return {
    id: `rsvp-${userId}-${status}`,
    eventId: 'event-render-helpers',
    userId,
    status,
    createdAt: WHEN,
    updatedAt: WHEN,
  } as EventRsvp;
}

describe('tallyPollFromRows', () => {
  // Passed out of position order so the cases below also check the sort.
  const options = [
    option({ id: 'opt-b', label: 'Beta', position: 1 }),
    option({ id: 'opt-a', label: 'Alpha', position: 0 }),
    option({ id: 'opt-c', label: 'Gamma', position: 2 }),
  ];

  it('returns a zero tally, in position order, when there are no votes', () => {
    expect(tallyPollFromRows(poll(), options, [])).toEqual([
      { optionId: 'opt-a', label: 'Alpha', position: 0, votes: 0, voterIds: [] },
      { optionId: 'opt-b', label: 'Beta', position: 1, votes: 0, voterIds: [] },
      { optionId: 'opt-c', label: 'Gamma', position: 2, votes: 0, voterIds: [] },
    ]);
  });

  it('counts votes spread across options and keeps voters in row order', () => {
    // No percentage is computed here. buildPollEmbed rounds (votes / total) * 100, so 1 of 3
    // votes would display as 33% and 2 of 3 as 67%. This helper keeps the raw counts.
    const votes = [
      vote({ optionId: 'opt-b', userId: 'u2' }),
      vote({ optionId: 'opt-a', userId: 'u1' }),
      vote({ optionId: 'opt-a', userId: 'u3' }),
    ];
    expect(tallyPollFromRows(poll(), options, votes)).toEqual([
      { optionId: 'opt-a', label: 'Alpha', position: 0, votes: 2, voterIds: ['u1', 'u3'] },
      { optionId: 'opt-b', label: 'Beta', position: 1, votes: 1, voterIds: ['u2'] },
      { optionId: 'opt-c', label: 'Gamma', position: 2, votes: 0, voterIds: [] },
    ]);
  });

  it('sorts options by position when the input order and the positions disagree', () => {
    const scrambled = [
      option({ id: 'late', label: 'Late', position: 10 }),
      option({ id: 'early', label: 'Early', position: 2 }),
      option({ id: 'mid', label: 'Mid', position: 7 }),
    ];
    const tallies = tallyPollFromRows(poll(), scrambled, [vote({ optionId: 'late', userId: 'u1' })]);
    expect(tallies.map((tally) => [tally.optionId, tally.position, tally.votes])).toEqual([
      ['early', 2, 0],
      ['mid', 7, 0],
      ['late', 10, 1],
    ]);
  });

  it('ignores votes that point at an unknown option id', () => {
    const votes = [
      vote({ optionId: 'missing', userId: 'u9' }),
      vote({ optionId: 'opt-a', userId: 'u1' }),
      vote({ optionId: 'also-missing', userId: 'u1' }),
    ];
    expect(tallyPollFromRows(poll(), options, votes)).toEqual([
      { optionId: 'opt-a', label: 'Alpha', position: 0, votes: 1, voterIds: ['u1'] },
      { optionId: 'opt-b', label: 'Beta', position: 1, votes: 0, voterIds: [] },
      { optionId: 'opt-c', label: 'Gamma', position: 2, votes: 0, voterIds: [] },
    ]);
  });

  it('returns no tallies when the poll has no options, even if vote rows exist', () => {
    expect(tallyPollFromRows(poll(), [], [vote({ optionId: 'orphan', userId: 'u1' })])).toEqual([]);
  });

  it('omits voter ids when the poll is anonymous, including options with no votes', () => {
    const votes = [
      vote({ optionId: 'opt-a', userId: 'u1' }),
      vote({ optionId: 'opt-a', userId: 'u2' }),
    ];
    const tallies = tallyPollFromRows(poll({ anonymous: true }), options, votes);
    expect(tallies[0]).not.toHaveProperty('voterIds');
    expect(tallies).toEqual([
      { optionId: 'opt-a', label: 'Alpha', position: 0, votes: 2 },
      { optionId: 'opt-b', label: 'Beta', position: 1, votes: 0 },
      { optionId: 'opt-c', label: 'Gamma', position: 2, votes: 0 },
    ]);
  });

  it('counts each selected option for one voter on a multi-select poll', () => {
    // multiSelect is not read. Each vote row is counted on its own option, same as a single-choice poll.
    const votes = [
      vote({ optionId: 'opt-a', userId: 'u1' }),
      vote({ optionId: 'opt-c', userId: 'u1' }),
      vote({ optionId: 'opt-c', userId: 'u2' }),
    ];
    const expected = [
      { optionId: 'opt-a', label: 'Alpha', position: 0, votes: 1, voterIds: ['u1'] },
      { optionId: 'opt-b', label: 'Beta', position: 1, votes: 0, voterIds: [] },
      { optionId: 'opt-c', label: 'Gamma', position: 2, votes: 2, voterIds: ['u1', 'u2'] },
    ];
    expect(tallyPollFromRows(poll({ multiSelect: true }), options, votes)).toEqual(expected);
    expect(tallyPollFromRows(poll({ multiSelect: false }), options, votes)).toEqual(expected);
  });
});

describe('summarizeRsvps', () => {
  it('returns zeroes for an empty list', () => {
    expect(summarizeRsvps([])).toEqual({ going: 0, maybe: 0, declined: 0 });
  });

  it('counts a mix of GOING, MAYBE, and DECLINED', () => {
    const rsvps = [
      rsvp('DECLINED', 'u3'),
      rsvp('GOING', 'u1'),
      rsvp('MAYBE', 'u2'),
      rsvp('GOING', 'u4'),
      rsvp('MAYBE', 'u5'),
    ];
    expect(summarizeRsvps(rsvps)).toEqual({ going: 2, maybe: 2, declined: 1 });
  });

  it.each([
    ['GOING', { going: 2, maybe: 0, declined: 0 }],
    ['MAYBE', { going: 0, maybe: 2, declined: 0 }],
    ['DECLINED', { going: 0, maybe: 0, declined: 2 }],
  ] as const)('counts only %s when that is the only status present', (status, expected) => {
    expect(summarizeRsvps([rsvp(status, 'u1'), rsvp(status, 'u2')])).toEqual(expected);
  });
});

function statusValue(embed: ReturnType<typeof buildPollEmbed>): string | undefined {
  return embed.data.fields?.find((field) => field.name === 'Status')?.value;
}

describe('buildPollEmbed status', () => {
  const tallies = [{ optionId: 'opt-a', label: 'Alpha', position: 0, votes: 1 }];

  it('shows Closed when the poll is closed', () => {
    const embed = buildPollEmbed(poll({ closed: true, endsAt: WHEN }), tallies, realT);
    expect(statusValue(embed)).toBe('Closed');
  });

  it('shows a relative Ends timestamp while the poll is open', () => {
    const embed = buildPollEmbed(poll({ closed: false, endsAt: WHEN }), tallies, realT);
    expect(statusValue(embed)).toBe(`Ends ${discordTimestamp(WHEN, 'R')}`);
  });

  it('shows Open when the poll has no end time', () => {
    const embed = buildPollEmbed(poll({ endsAt: null, closed: false }), tallies, realT);
    expect(statusValue(embed)).toBe('Open');
  });
});

function event(partial: Partial<CommunityEvent> = {}): CommunityEvent {
  return {
    id: 'event-render-helpers',
    guildId: 'guild-render-helpers',
    channelId: 'ch-render-helpers',
    messageId: null,
    title: 'Game night',
    description: null,
    startsAt: WHEN,
    endsAt: null,
    hostId: 'user-host',
    discordEventId: null,
    reminderMinutes: [],
    createdAt: WHEN,
    updatedAt: WHEN,
    ...partial,
  };
}

describe('buildEventEmbed ends field', () => {
  const counts = { going: 1, maybe: 0, declined: 0 };

  it('includes an Ends field when the event has an end time', () => {
    const endsAt = new Date('2026-11-23T21:00:00.000Z');
    const embed = buildEventEmbed(event({ endsAt }), counts, realT);
    const ends = embed.data.fields?.find((field) => field.name === 'Ends');
    expect(ends).toMatchObject({ name: 'Ends', value: discordTimestamp(endsAt, 'F'), inline: true });
    expect(embed.data.fields?.map((field) => field.name)).toEqual(['Starts', 'Ends', 'Host', 'RSVPs']);
  });

  it('omits the Ends field when the event has no end time', () => {
    const embed = buildEventEmbed(event({ endsAt: null }), counts, realT);
    expect(embed.data.fields?.some((field) => field.name === 'Ends')).toBe(false);
    expect(embed.data.fields?.map((field) => field.name)).toEqual(['Starts', 'Host', 'RSVPs']);
  });

  it('renders English field names, RSVP counts, the calendar title, and the no-description fallback', () => {
    const endsAt = new Date('2026-11-23T21:00:00.000Z');
    const embed = buildEventEmbed(
      event({ endsAt, title: 'Game night', description: null, hostId: 'user-host' }),
      { going: 4, maybe: 2, declined: 7 },
      realT,
    );
    expect(embed.data.fields?.map((field) => field.name)).toEqual(['Starts', 'Ends', 'Host', 'RSVPs']);
    expect(embed.data.fields?.find((field) => field.name === 'RSVPs')?.value).toBe(
      '✅ Going: 4 · ❔ Maybe: 2 · ❌ Declined: 7',
    );
    expect(embed.data.title).toBe('📅 Game night');
    expect(embed.data.description).toBe('_No description._');
  });

  it('prefixes a cancelled event title and leaves a written description in place', () => {
    const embed = buildEventEmbed(
      event({ title: 'Game night', description: 'Bring snacks' }),
      counts,
      realT,
      true,
    );
    expect(embed.data.title).toBe('🚫 Cancelled: Game night');
    expect(embed.data.description).toBe('Bring snacks');
  });

  it('reads the remaining embed copy from the translator', () => {
    const endsAt = new Date('2026-11-23T21:00:00.000Z');
    const embed = buildEventEmbed(
      event({ endsAt, title: 'Game night', description: null }),
      { going: 4, maybe: 2, declined: 7 },
      (key) => `loc:${key}`,
      true,
    );
    expect(embed.data.fields?.map((field) => field.name)).toEqual([
      'loc:event.embedStarts',
      'loc:event.embedEnds',
      'loc:event.embedHost',
      'loc:event.embedRsvps',
    ]);
    expect(embed.data.fields?.find((field) => field.name === 'loc:event.embedRsvps')?.value).toBe(
      'loc:event.embedRsvpCounts',
    );
    expect(embed.data.title).toBe('loc:event.embedTitleCancelled');
    expect(embed.data.description).toBe('loc:event.embedNoDescription');
  });
});
