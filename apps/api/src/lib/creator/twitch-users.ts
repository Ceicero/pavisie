// Resolving a Twitch login to a stable Twitch user id from the API, for the creator's "adjust a viewer's balance" action
// (ARCHITECTURE.md §19e). Uses the shared Helix APP (client-credentials) token — the same token the live-status lookup
// uses — never a broadcaster's or the bot's user token. The login is validated against Twitch's own alphabet BEFORE
// any request, and nothing here logs the login.
import { env } from '@pavisie/core';
import { getTwitchAppToken } from '@pavisie/plugins/integrations/providers/twitch';
import type { ZodFastifyInstance } from '../http';
import { twitchLiveStatusContextFrom } from '../integrations/live-status';

/** Twitch's own login rules (lowercase letters, digits, underscore; 1-25 chars) — the same pattern the `!give` chat
 * command enforces before it ever calls Helix. */
export const TWITCH_LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;

/** Normalises what a streamer typed (`@SomeViewer` -> `someviewer`); does NOT validate — see {@link TWITCH_LOGIN_PATTERN}. */
export function normalizeTwitchLogin(input: string): string {
  return input.trim().replace(/^@/, '').toLowerCase();
}

export interface TwitchUserLookup {
  id: string;
  login: string;
  displayName: string;
}

/** `{ ok: false }` = the lookup itself failed (Twitch not configured, token unavailable, network/HTTP error) — never
 * to be reported as "no such user"; `{ ok: true, user: null }` = Twitch answered and there is no such login. */
export type TwitchUserLookupResult = { ok: true; user: TwitchUserLookup | null } | { ok: false };

interface HelixUsersResponse {
  data: { id: string; login: string; display_name: string }[];
}

export async function lookupTwitchUserByLogin(app: ZodFastifyInstance, login: string): Promise<TwitchUserLookupResult> {
  if (!TWITCH_LOGIN_PATTERN.test(login)) return { ok: true, user: null };

  const clientId = env.TWITCH_CLIENT_ID;
  if (!clientId) return { ok: false };

  try {
    const token = await getTwitchAppToken(twitchLiveStatusContextFrom(app));
    if (!token) return { ok: false };
    const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
    });
    if (!res.ok) {
      app.log.warn({ status: res.status }, 'creator/economy: Twitch Helix /users request failed');
      return { ok: false };
    }
    const json = (await res.json()) as HelixUsersResponse;
    const user = json.data[0];
    return { ok: true, user: user ? { id: user.id, login: user.login, displayName: user.display_name } : null };
  } catch (err) {
    app.log.warn({ err }, 'creator/economy: Twitch Helix /users request threw');
    return { ok: false };
  }
}
