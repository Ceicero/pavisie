import { describe, expect, it } from 'vitest';
import { toInputJsonValue } from '../json';

// Case metadata is written after Discord has applied the action, so this must never reject what the database
// layer used to accept: same result as JSON.stringify, never a throw for ordinary values.
describe('toInputJsonValue', () => {
  it('keeps plain metadata as it is', () => {
    expect(toInputJsonValue({ roleId: '1', enforcerMute: true, seconds: 30, nickname: null })).toEqual({
      roleId: '1',
      enforcerMute: true,
      seconds: 30,
      nickname: null,
    });
  });

  it('matches JSON.stringify for values JSON cannot hold, instead of throwing', () => {
    const at = new Date('2026-11-14T00:00:00.000Z');
    expect(toInputJsonValue({ at, skipped: undefined, ratio: Number.NaN, list: [1, undefined] })).toEqual({
      at: '2026-11-14T00:00:00.000Z',
      ratio: null,
      list: [1, null],
    });
  });
});
