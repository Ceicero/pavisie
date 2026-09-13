// Small, dependency-free helpers for the public site's environment-driven links (ARCHITECTURE.md §17). The web
// app does not depend on `@pavisie/core`, so these read `process.env.NEXT_PUBLIC_*` directly — Next.js inlines
// every `NEXT_PUBLIC_*` reference into both the server and client bundles at build time.
import inviteDefaults from '../data/invite.json';

/** Base URL of the Pavisie API (`@pavisie/api`). No trailing slash. */
export function apiUrl(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
}

/** Optional public support/community server invite link. `null` when not configured — callers hide the link. */
export function supportServerUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPPORT_SERVER_URL;
  return url && url.trim().length > 0 ? url : null;
}

/**
 * Discord "Add to Discord" OAuth invite URL, built from `NEXT_PUBLIC_DISCORD_CLIENT_ID` and
 * `NEXT_PUBLIC_INVITE_PERMISSIONS` (falling back to the least-privilege bitfield generated from
 * `INVITE_PERMISSIONS` by `pnpm commands:export`, checked in at `src/data/invite.json`). Returns `null` when no
 * client id is configured at all (nothing to invite yet) so callers can disable/hide the CTA instead of linking
 * to a broken authorize URL.
 */
const ADMINISTRATOR_BIT = 1n << 3n;

/** Masks the Administrator bit out of a permissions bitfield string. Falls back to the checked-in default (also masked) if `raw` isn't a valid integer — a misconfigured env value must never widen to Administrator, let alone publish an invite that silently requests it. */
function safePermissions(raw: string | undefined): string {
  const fallback = inviteDefaults.permissions;
  const source = raw && raw.trim().length > 0 ? raw : fallback;
  try {
    const bits = BigInt(source);
    return (bits & ~ADMINISTRATOR_BIT).toString();
  } catch {
    try {
      return (BigInt(fallback) & ~ADMINISTRATOR_BIT).toString();
    } catch {
      return '0';
    }
  }
}

export function inviteUrl(): string | null {
  const clientId = process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID;
  if (!clientId || clientId === '0' || clientId.trim().length === 0) return null;
  const permissions = safePermissions(process.env.NEXT_PUBLIC_INVITE_PERMISSIONS);
  const scope = inviteDefaults.scopes.join(' ');
  const params = new URLSearchParams({ client_id: clientId, permissions, scope });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export const SITE_URL = 'https://pavisie.com';

/** Public source repository (AGPL-3.0). Pavisie is open source — linked from the footer. */
export const GITHUB_URL = 'https://github.com/Ceicero/pavisie';
