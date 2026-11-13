import type { ApiError } from '@pavisie/types';
import { apiUrl } from '../site';

/**
 * Local copies of the public leaderboard DTOs from PR #46 (`packages/types/src/engagement.ts`).
 * Kept here so this page can land on main before #46 merges; swap these for
 * `@pavisie/types/engagement` in this file only once that PR is in.
 */
export interface PublicLeaderboardEntryDto {
  rank: number;
  userId: string;
  username: string | null;
  globalName: string | null;
  avatarUrl: string | null;
  xp: number;
  level: number;
  messages: number;
  voiceMinutes: number;
}

export interface PublicLeaderboardDto {
  guildId: string;
  items: PublicLeaderboardEntryDto[];
  nextCursor: string | null;
  total: number;
}

/** Matches the API snowflake param (`17–20` decimal digits). */
export const GUILD_ID_PATTERN = /^\d{17,20}$/;

export const PUBLIC_LEADERBOARD_LIMIT = 25;

export const NOT_PUBLIC_MESSAGE = "This leaderboard isn't public.";
export const EMPTY_LEADERBOARD_MESSAGE = 'No ranked members yet.';
export const INVALID_GUILD_MESSAGE = "This isn't a valid leaderboard link.";

export function isGuildSnowflake(guildId: string): boolean {
  return GUILD_ID_PATTERN.test(guildId);
}

export function leaderboardDisplayName(
  entry: Pick<PublicLeaderboardEntryDto, 'globalName' | 'username'>,
): string {
  const globalName = entry.globalName?.trim();
  if (globalName) return globalName;
  const username = entry.username?.trim();
  if (username) return username;
  return 'Unknown user';
}

export function formatVoiceMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes.toLocaleString()} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (remaining === 0) return `${hours.toLocaleString()}h`;
  return `${hours.toLocaleString()}h ${remaining}m`;
}

export class PublicLeaderboardError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status: number; code: string }) {
    super(message);
    this.name = 'PublicLeaderboardError';
    this.status = options.status;
    this.code = options.code;
  }
}

export function isNotPublicError(error: unknown): boolean {
  return error instanceof PublicLeaderboardError && error.status === 404;
}

export const publicLeaderboardQueryKeys = {
  page: (guildId: string, cursor?: string) =>
    ['public-leaderboard', guildId, cursor ?? null] as const,
};

/** Session-less GET of the public leaderboard. Does not send cookies or a CSRF token. */
export async function fetchPublicLeaderboard(
  guildId: string,
  cursor?: string,
  limit: number = PUBLIC_LEADERBOARD_LIMIT,
): Promise<PublicLeaderboardDto> {
  const qs = new URLSearchParams();
  if (cursor) qs.set('cursor', cursor);
  qs.set('limit', String(limit));
  const url = `${apiUrl()}/guilds/${guildId}/engagement/leaderboard/public?${qs.toString()}`;

  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  } catch {
    throw new PublicLeaderboardError(
      'Could not reach the Pavisie API. Check your connection and try again.',
      {
        status: 0,
        code: 'network_error',
      },
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload: unknown = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => null);

  if (!response.ok) {
    const errorBody =
      payload && typeof payload === 'object' && 'error' in (payload as Record<string, unknown>)
        ? (payload as ApiError).error
        : null;
    throw new PublicLeaderboardError(
      errorBody?.message ?? `Request failed with status ${response.status}`,
      {
        status: response.status,
        code: errorBody?.code ?? 'unknown_error',
      },
    );
  }

  return payload as PublicLeaderboardDto;
}
