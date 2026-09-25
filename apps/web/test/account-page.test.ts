import { describe, expect, it } from 'vitest';
import { TWITCH_LINK_ERROR_MESSAGES } from '../src/app/dashboard/account/page';

/**
 * `TWITCH_LINK_ERROR_MESSAGES` must stay in sync with the `?error=` codes
 * `apps/api/src/routes/auth.ts`'s twitch-link callback branch can actually redirect with (its
 * `TWITCH_LINK_ERROR` constant) — a code missing here would render as a raw, un-mapped string instead of
 * a human-readable message. No shared import exists across the two apps for this small string table, so
 * this test pins the exact set by hand; update both sides together if the API's codes ever change.
 */
const API_TWITCH_LINK_ERROR_CODES = [
  'twitch-link-no-verified-connection',
  'twitch-link-multiple-connections',
  'twitch-link-already-claimed',
];

describe('TWITCH_LINK_ERROR_MESSAGES', () => {
  it('has a human-readable message for every error code the API callback can redirect with', () => {
    for (const code of API_TWITCH_LINK_ERROR_CODES) {
      expect(TWITCH_LINK_ERROR_MESSAGES[code]).toBeTruthy();
      expect(typeof TWITCH_LINK_ERROR_MESSAGES[code]).toBe('string');
    }
  });

  it('has no stray codes beyond what the API can actually send', () => {
    expect(Object.keys(TWITCH_LINK_ERROR_MESSAGES).sort()).toEqual([...API_TWITCH_LINK_ERROR_CODES].sort());
  });
});
