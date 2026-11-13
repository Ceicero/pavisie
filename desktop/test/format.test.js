import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatCount,
  formatDay,
  formatRelative,
  formatShare,
  humanize,
  niceTicks,
  sumOf,
} from '../src/renderer/format.js';

test('formatCount keeps small numbers exact and compacts large ones', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(1284), '1,284');
  assert.equal(formatCount(9999), '9,999');
  assert.equal(formatCount(12_900), '12.9K');
  assert.equal(formatCount(84_000), '84K');
  assert.equal(formatCount(250_400), '250K');
  assert.equal(formatCount(4_200_000), '4.2M');
  assert.equal(formatCount(null), '—');
  assert.equal(formatCount(undefined), '—');
});

test('formatDay reads the UTC day straight from the string', () => {
  assert.equal(formatDay('2026-11-03'), 'Nov 3');
  assert.equal(formatDay('2026-01-31T23:59:59.000Z'), 'Jan 31');
  assert.equal(formatDay('nonsense'), '—');
});

test('formatRelative picks a readable unit', () => {
  const now = Date.UTC(2026, 10, 13, 12);
  assert.equal(formatRelative(new Date(now - 20_000).toISOString(), now), 'just now');
  assert.equal(formatRelative(new Date(now - 5 * 60_000).toISOString(), now), '5 min ago');
  assert.equal(formatRelative(new Date(now - 3 * 3_600_000).toISOString(), now), '3 hr ago');
  assert.equal(formatRelative(new Date(now - 86_400_000).toISOString(), now), '1 day ago');
  assert.equal(formatRelative(new Date(now - 4 * 86_400_000).toISOString(), now), '4 days ago');
  assert.equal(formatRelative('2026-03-02T00:00:00Z', now), 'Mar 2, 2026');
  assert.equal(formatRelative(null, now), '—');
});

test('formatShare never divides by zero', () => {
  assert.equal(formatShare(23, 50), '46%');
  assert.equal(formatShare(0, 0), '0%');
});

test('humanize turns enum and ledger names into words', () => {
  assert.equal(humanize('twitch_chat_earn'), 'Twitch chat earn');
  assert.equal(humanize('GOOGLE_CALENDAR', { titleCase: true }), 'Google Calendar');
  assert.equal(humanize('data-request'), 'Data request');
  assert.equal(humanize(''), '—');
});

test('niceTicks start at zero, cover the max, and use round whole steps', () => {
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(3), [0, 1, 2, 3]);
  assert.deepEqual(niceTicks(1311), [0, 500, 1000, 1500]);
  assert.deepEqual(niceTicks(9000, 2), [0, 5000, 10000]);
  for (const max of [1, 2, 7, 43, 999, 12_345, 7_000_000]) {
    const ticks = niceTicks(max);
    assert.equal(ticks[0], 0);
    assert.ok(ticks.at(-1) >= max, `covers ${max}`);
    assert.ok(
      ticks.every((t) => Number.isInteger(t)),
      `whole steps for ${max}`,
    );
    assert.ok(ticks.length <= 7, `not too many ticks for ${max}`);
  }
});

test('sumOf treats missing values as zero', () => {
  assert.equal(sumOf([{ a: 2 }, { a: 3 }, {}, { a: null }], 'a'), 5);
  assert.equal(sumOf(undefined, 'a'), 0);
});
