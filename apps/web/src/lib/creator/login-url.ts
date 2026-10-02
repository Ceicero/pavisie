import { API_BASE_URL } from '@/lib/dashboard/api';

/**
 * URL that starts a creator sign-in for a platform (the API runs the OAuth flow). Twitch only today; Kick will add
 * its own route. Kept in its own server-safe module (no `'use client'`) so the public homepage can link straight to
 * it as well as the creator session provider (`session.tsx`, which re-exports it).
 */
export function creatorLoginUrl(platform: 'twitch'): string {
  return `${API_BASE_URL}/creator/auth/${platform}/login`;
}
