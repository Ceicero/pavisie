import { describe, expect, it } from 'vitest';
import {
  checkGiveawayEligibility,
  decidePollVote,
  isValidSuggestionTransition,
  pickWinners,
  pollOutcome,
  rerollPool,
  tallyPoll,
  toggleSuggestionVote,
  uniqueGiveawayEntries,
  upcomingReminderMinutes,
} from '../service';

describe('tallyPoll', () => {
  const options = [
    { id: 'a', label: 'Cats', position: 0 },
    { id: 'b', label: 'Dogs', position: 1 },
  ];

  it('counts votes per option, ordered by position', () => {
    const votes = [
      { optionId: 'a', userId: 'u1' },
      { optionId: 'a', userId: 'u2' },
      { optionId: 'b', userId: 'u3' },
    ];
    const tallies = tallyPoll(options, votes, false);
    expect(tallies).toEqual([
      { optionId: 'a', label: 'Cats', position: 0, votes: 2, voterIds: ['u1', 'u2'] },
      { optionId: 'b', label: 'Dogs', position: 1, votes: 1, voterIds: ['u3'] },
    ]);
  });

  it('masks voter ids for anonymous polls', () => {
    const votes = [{ optionId: 'a', userId: 'u1' }];
    const tallies = tallyPoll(options, votes, true);
    expect(tallies[0]).not.toHaveProperty('voterIds');
    expect(tallies[0].votes).toBe(1);
  });

  it('reports zero votes for options nobody picked', () => {
    const tallies = tallyPoll(options, [], false);
    expect(tallies.every((t) => t.votes === 0)).toBe(true);
  });
});

describe('decidePollVote', () => {
  it('single-select: voting a new option replaces any existing vote', () => {
    const decision = decidePollVote('b', ['a'], false);
    expect(decision).toEqual({ removeOptionIds: ['a'], add: true });
  });

  it('single-select: clicking the already-voted option removes it', () => {
    const decision = decidePollVote('a', ['a'], false);
    expect(decision).toEqual({ removeOptionIds: ['a'], add: false });
  });

  it('multi-select: toggles the clicked option independently of others', () => {
    expect(decidePollVote('b', ['a'], true)).toEqual({ removeOptionIds: [], add: true });
    expect(decidePollVote('a', ['a', 'b'], true)).toEqual({ removeOptionIds: ['a'], add: false });
  });
});

describe('pickWinners', () => {
  it('picks exactly n winners without replacement, using the injected rng', () => {
    const entries = [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }, { userId: 'd' }];
    // Always pick index 0 of the shrinking pool: a, then (b,c,d)->0 => b.
    const sequence = [0, 0];
    let i = 0;
    const rng = (_max: number) => sequence[i++];
    const winners = pickWinners(entries, 2, rng);
    expect(winners.map((w) => w.userId)).toEqual(['a', 'b']);
  });

  it('never returns duplicate entries even if asked for more winners than entries', () => {
    const entries = [{ userId: 'a' }, { userId: 'b' }];
    const winners = pickWinners(entries, 5, () => 0);
    expect(winners).toHaveLength(2);
    expect(new Set(winners.map((w) => w.userId)).size).toBe(2);
  });

  it('returns an empty array for zero entries or zero requested winners', () => {
    expect(pickWinners([], 3, () => 0)).toEqual([]);
    expect(pickWinners([{ userId: 'a' }], 0, () => 0)).toEqual([]);
  });

  it('is deterministic for a given rng sequence', () => {
    const entries = [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }];
    const rngA = (() => {
      const seq = [2, 0];
      let i = 0;
      return () => seq[i++];
    })();
    const rngB = (() => {
      const seq = [2, 0];
      let i = 0;
      return () => seq[i++];
    })();
    expect(pickWinners(entries, 2, rngA)).toEqual(pickWinners(entries, 2, rngB));
  });
});

describe('checkGiveawayEligibility', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const base = {
    giveaway: { ended: false, requiredRoleIds: [] as string[], minAccountAgeDays: null, minLevel: null },
    member: { roleIds: [] as string[], accountCreatedAt: new Date('2020-01-01T00:00:00Z'), level: 0 },
    now,
  };

  it('rejects entries to an ended giveaway', () => {
    expect(checkGiveawayEligibility({ ...base, giveaway: { ...base.giveaway, ended: true } })).toEqual({
      ok: false,
      reason: 'ended',
    });
  });

  it('requires one of the required roles when set', () => {
    const input = { ...base, giveaway: { ...base.giveaway, requiredRoleIds: ['r1'] } };
    expect(checkGiveawayEligibility(input)).toEqual({ ok: false, reason: 'missing_role' });
    expect(checkGiveawayEligibility({ ...input, member: { ...base.member, roleIds: ['r1'] } })).toEqual({
      ok: true,
    });
  });

  it('enforces minimum account age', () => {
    const input = {
      ...base,
      giveaway: { ...base.giveaway, minAccountAgeDays: 30 },
      member: { ...base.member, accountCreatedAt: new Date('2025-12-25T00:00:00Z') },
    };
    expect(checkGiveawayEligibility(input)).toEqual({ ok: false, reason: 'account_too_new' });
  });

  it('enforces minimum level', () => {
    const input = { ...base, giveaway: { ...base.giveaway, minLevel: 5 } };
    expect(checkGiveawayEligibility(input)).toEqual({ ok: false, reason: 'below_min_level' });
    expect(checkGiveawayEligibility({ ...input, member: { ...base.member, level: 5 } })).toEqual({
      ok: true,
    });
  });

  it('allows entry when every condition passes', () => {
    expect(checkGiveawayEligibility(base)).toEqual({ ok: true });
  });
});

describe('toggleSuggestionVote', () => {
  it('adds a vote when there was none', () => {
    expect(toggleSuggestionVote(null, 1)).toEqual({ newValue: 1, upvoteDelta: 1, downvoteDelta: 0 });
    expect(toggleSuggestionVote(null, -1)).toEqual({ newValue: -1, upvoteDelta: 0, downvoteDelta: 1 });
  });

  it('removes a vote when clicking the same direction again', () => {
    expect(toggleSuggestionVote(1, 1)).toEqual({ newValue: null, upvoteDelta: -1, downvoteDelta: 0 });
    expect(toggleSuggestionVote(-1, -1)).toEqual({ newValue: null, upvoteDelta: 0, downvoteDelta: -1 });
  });

  it('switches a vote when clicking the opposite direction', () => {
    expect(toggleSuggestionVote(1, -1)).toEqual({ newValue: -1, upvoteDelta: -1, downvoteDelta: 1 });
    expect(toggleSuggestionVote(-1, 1)).toEqual({ newValue: 1, upvoteDelta: 1, downvoteDelta: -1 });
  });
});

describe('isValidSuggestionTransition', () => {
  it('allows any transition to a different status', () => {
    expect(isValidSuggestionTransition('PENDING', 'APPROVED')).toBe(true);
    expect(isValidSuggestionTransition('DENIED', 'PENDING')).toBe(true);
  });

  it('rejects a no-op transition to the same status', () => {
    expect(isValidSuggestionTransition('APPROVED', 'APPROVED')).toBe(false);
  });
});

describe('rerollPool', () => {
  const entries = [{ userId: 'a' }, { userId: 'b' }, { userId: 'a' }];

  it('excludes previous winners and duplicate entrants', () => {
    expect(rerollPool(entries, ['a'], 1).map((entry) => entry.userId)).toEqual(['b']);
  });

  it('returns nobody when the only entrant already won', () => {
    expect(rerollPool([{ userId: 'a' }], ['a'], 1)).toEqual([]);
    expect(rerollPool([], [], 1)).toEqual([]);
  });

  it('returns nobody when no new winners were requested', () => {
    expect(rerollPool(entries, [], 0)).toEqual([]);
  });

  it('keeps a single entrant eligible for the original draw', () => {
    expect(uniqueGiveawayEntries(entries).map((entry) => entry.userId)).toEqual(['a', 'b']);
  });
});

describe('pollOutcome', () => {
  const tallies = [
    { optionId: 'a', label: 'Cats', position: 0, votes: 2 },
    { optionId: 'b', label: 'Dogs', position: 1, votes: 2 },
    { optionId: 'c', label: 'Birds', position: 2, votes: 1 },
  ];

  it('reports a tie between every option that shares the top count', () => {
    expect(pollOutcome(tallies)).toEqual({
      kind: 'tie',
      optionIds: ['a', 'b'],
      labels: ['Cats', 'Dogs'],
      votes: 2,
    });
  });

  it('reports a single winner', () => {
    expect(pollOutcome([{ ...tallies[0]!, votes: 3 }, tallies[1]!, tallies[2]!])).toMatchObject({
      kind: 'winner',
      optionIds: ['a'],
      labels: ['Cats'],
      votes: 3,
    });
  });

  it('reports no result when nobody voted', () => {
    expect(pollOutcome(tallies.map((tally) => ({ ...tally, votes: 0 }))).kind).toBe('none');
  });
});

describe('upcomingReminderMinutes', () => {
  it('keeps only marks that still have time to fire before the event starts', () => {
    const startsAt = new Date('2026-01-01T12:00:00Z');
    const now = new Date('2026-01-01T11:05:00Z'); // 55 minutes before start
    expect(upcomingReminderMinutes([60, 10], startsAt, now)).toEqual([10]);
  });

  it('keeps every mark when called well before the event', () => {
    const startsAt = new Date('2026-01-01T12:00:00Z');
    const now = new Date('2026-01-01T00:00:00Z');
    expect(upcomingReminderMinutes([60, 10], startsAt, now)).toEqual([60, 10]);
  });
});
