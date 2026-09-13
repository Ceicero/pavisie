import { ExternalServiceError, env } from '@pavisie/core';
import type { IntegrationProvider } from '@pavisie/database';
import {
  INTEGRATION_PROVIDER_IDS,
  type IntegrationProviderId as CanonicalProviderId,
  type IntegrationProviderInfoDto,
  type IntegrationProviderKind,
} from '@pavisie/types/integrations';

// GitHub, Notion and Stripe (the guild-facing connector) were removed as offered providers on 2026-09-02
// (Brandon's decision) — their Prisma `IntegrationProvider` enum values are retained for historical rows only
// (schema.prisma), but they are deliberately absent from every id/config list in this file.
export type OAuthProviderId = 'twitch' | 'google' | 'microsoft' | 'instagram' | 'reddit';
/** Providers that connect via an inbound webhook endpoint (a secret + URL) rather than OAuth. */
export type WebhookProviderId = 'generic_webhook';
export type IntegrationProviderId = OAuthProviderId | WebhookProviderId;

export const OAUTH_PROVIDER_IDS: readonly OAuthProviderId[] = [
  'twitch',
  'google',
  'microsoft',
  'instagram',
  'reddit',
];
export const WEBHOOK_PROVIDER_IDS: readonly WebhookProviderId[] = ['generic_webhook'];

interface EnvKeys {
  clientId:
    | 'TWITCH_CLIENT_ID'
    | 'GOOGLE_CLIENT_ID'
    | 'MICROSOFT_CLIENT_ID'
    | 'INSTAGRAM_CLIENT_ID'
    | 'REDDIT_CLIENT_ID';
  clientSecret:
    | 'TWITCH_CLIENT_SECRET'
    | 'GOOGLE_CLIENT_SECRET'
    | 'MICROSOFT_CLIENT_SECRET'
    | 'INSTAGRAM_CLIENT_SECRET'
    | 'REDDIT_CLIENT_SECRET';
}

export interface OAuthProviderConfig {
  id: OAuthProviderId;
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  envKeys: EnvKeys;
  extraAuthorizeParams?: Record<string, string>;
  /** 'basic' = client credentials sent as an HTTP Basic Authorization header (Reddit requires this); 'body' = sent as form fields. */
  tokenAuthStyle: 'body' | 'basic';
}

export const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProviderConfig> = {
  twitch: {
    id: 'twitch',
    label: 'Twitch',
    authorizeUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scope: '',
    envKeys: { clientId: 'TWITCH_CLIENT_ID', clientSecret: 'TWITCH_CLIENT_SECRET' },
    tokenAuthStyle: 'body',
  },
  google: {
    id: 'google',
    label: 'Google Calendar',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    envKeys: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },
    extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    tokenAuthStyle: 'body',
  },
  microsoft: {
    id: 'microsoft',
    label: 'Microsoft 365 Calendar',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access Calendars.Read',
    envKeys: { clientId: 'MICROSOFT_CLIENT_ID', clientSecret: 'MICROSOFT_CLIENT_SECRET' },
    tokenAuthStyle: 'body',
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    // Instagram API with Instagram Login (the surviving API since the Dec 2024 Basic Display API shutdown) —
    // own-account-only by design: this authorize screen only ever grants access to the signer's own account.
    authorizeUrl: 'https://www.instagram.com/oauth/authorize',
    tokenUrl: 'https://api.instagram.com/oauth/access_token',
    scope: 'instagram_business_basic',
    envKeys: { clientId: 'INSTAGRAM_CLIENT_ID', clientSecret: 'INSTAGRAM_CLIENT_SECRET' },
    tokenAuthStyle: 'body',
  },
  reddit: {
    id: 'reddit',
    label: 'Reddit',
    authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    scope: 'identity read',
    envKeys: { clientId: 'REDDIT_CLIENT_ID', clientSecret: 'REDDIT_CLIENT_SECRET' },
    extraAuthorizeParams: { duration: 'permanent' },
    tokenAuthStyle: 'basic',
  },
};

/** Maps our lowercase provider ids to Prisma's `IntegrationProvider` enum values. */
export const PROVIDER_ENUM_MAP: Record<IntegrationProviderId, IntegrationProvider> = {
  twitch: 'TWITCH',
  google: 'GOOGLE_CALENDAR',
  microsoft: 'MICROSOFT_CALENDAR',
  instagram: 'INSTAGRAM',
  reddit: 'REDDIT',
  generic_webhook: 'GENERIC_WEBHOOK',
};

export function isOAuthProvider(id: string): id is OAuthProviderId {
  return (OAUTH_PROVIDER_IDS as readonly string[]).includes(id);
}

export function isWebhookProvider(id: string): id is WebhookProviderId {
  return (WEBHOOK_PROVIDER_IDS as readonly string[]).includes(id);
}

/** True if both the client id and secret env vars are set for `providerId`. */
export function isOAuthProviderConfigured(providerId: OAuthProviderId): boolean {
  const cfg = OAUTH_PROVIDERS[providerId];
  return Boolean(env[cfg.envKeys.clientId] && env[cfg.envKeys.clientSecret]);
}

/**
 * Builds the provider's OAuth2 authorize URL with the given anti-CSRF `state`.
 *
 * `scopeOverride` lets a caller request a different scope than the provider's default `cfg.scope` for this one
 * authorize URL, without touching that default — used by the Twitch chat-bot flows (`routes/twitch-chat.ts`'s
 * per-guild `channel:bot` connect, `routes/twitch-bot.ts`'s owner-only `user:read:chat user:write:chat user:bot`
 * connect) so the existing generic Twitch integration's consent screen (`cfg.scope === ''`) never changes.
 */
export function buildProviderAuthorizeUrl(
  providerId: OAuthProviderId,
  state: string,
  redirectUri: string,
  scopeOverride?: string,
): string {
  const cfg = OAUTH_PROVIDERS[providerId];
  const clientId = env[cfg.envKeys.clientId];
  if (!clientId) {
    throw new ExternalServiceError(`${cfg.label} is not configured on this server.`);
  }
  const scope = scopeOverride ?? cfg.scope;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    ...(scope ? { scope } : {}),
    ...cfg.extraAuthorizeParams,
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

export interface ExchangedProviderToken {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  /** Normalized to a string array regardless of how the provider sent it — see `normalizeScope`. */
  scopes: string[];
}

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  /** Most providers send a space-delimited string, but Twitch's `POST /oauth2/token` sends a JSON array of
   * strings instead (e.g. `["user:read:chat","user:write:chat","user:bot"]`). Typed as either shape so callers
   * can't reach for a bare `.split()` that only works for one of them — always go through `normalizeScope`. */
  scope?: string | string[];
}

/** Normalizes a provider's token-response `scope` — a space-delimited string for most providers, a JSON array
 * for Twitch (see `RawTokenResponse.scope`) — into a single consistent `string[]` shape for callers. */
function normalizeScope(scope: string | string[] | undefined): string[] {
  if (!scope) return [];
  if (Array.isArray(scope)) return scope.filter(Boolean);
  return scope.split(' ').filter(Boolean);
}

/** Exchanges an OAuth `code` for tokens with the provider's token endpoint. */
export async function exchangeProviderCode(
  providerId: OAuthProviderId,
  code: string,
  redirectUri: string,
): Promise<ExchangedProviderToken> {
  const cfg = OAUTH_PROVIDERS[providerId];
  const clientId = env[cfg.envKeys.clientId];
  const clientSecret = env[cfg.envKeys.clientSecret];
  if (!clientId || !clientSecret) {
    throw new ExternalServiceError(`${cfg.label} is not configured on this server.`);
  }

  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (cfg.tokenAuthStyle === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
  }

  const res = await fetch(cfg.tokenUrl, { method: 'POST', headers, body });
  if (!res.ok) {
    throw new ExternalServiceError(`${cfg.label} token exchange failed (${res.status}).`);
  }
  const json = (await res.json()) as RawTokenResponse;

  if (providerId === 'instagram') {
    return exchangeInstagramLongLivedToken(json, clientSecret);
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    tokenType: json.token_type,
    scopes: normalizeScope(json.scope),
  };
}

/** Instagram's token endpoint returns `permissions` where every other provider here returns `scope`. */
interface RawInstagramCodeExchange extends RawTokenResponse {
  permissions?: string[] | string;
}

/**
 * Second leg of Instagram's two-step OAuth. Its authorization-code grant returns a **short-lived token good for
 * one hour**, with no `refresh_token` and no `expires_in` at all — which, left as-is, breaks the integration in
 * two compounding ways: the stored `OAuthToken.expiresAt` is `null`, so `jobs/token-refresh.ts` (which selects
 * on `expiresAt: { not: null, lt: ... }`) never considers the row again; and `refresh_access_token`
 * (`ig_refresh_token`, see `refreshInstagramToken` in the plugins package) only accepts *long-lived* tokens, so
 * even a manual refresh would fail. The connection would poll happily for an hour and then error forever.
 *
 * So the short-lived token is immediately traded for the ~60-day long-lived one, which IS refreshable, before
 * anything is persisted. Done here rather than in the OAuth callback so `routes/oauth-integrations.ts` stays
 * provider-agnostic and there is exactly one place a token reaches the caller.
 *
 * A failure here is fatal on purpose: storing the one-hour token would look like a successful connect and then
 * silently rot, which is worse than telling the user the connection failed while they are still on the page.
 */
async function exchangeInstagramLongLivedToken(
  shortLived: RawInstagramCodeExchange,
  clientSecret: string,
): Promise<ExchangedProviderToken> {
  const params = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: clientSecret,
    access_token: shortLived.access_token,
  });
  const res = await fetch(`https://graph.instagram.com/access_token?${params.toString()}`);
  if (!res.ok) {
    throw new ExternalServiceError(`Instagram long-lived token exchange failed (${res.status}).`);
  }
  const json = (await res.json()) as RawTokenResponse;
  return {
    accessToken: json.access_token,
    // Deliberately none: Instagram issues no refresh token, the long-lived access token re-issues itself.
    refreshToken: undefined,
    expiresIn: json.expires_in,
    tokenType: json.token_type,
    // The granted permissions come back on the *first* leg, not this one.
    scopes: normalizeScope(shortLived.permissions ?? shortLived.scope),
  };
}

export interface TwitchHelixUser {
  id: string;
  login: string;
  displayName: string;
}

interface RawTwitchUsersResponse {
  data?: { id: string; login: string; display_name: string }[];
}

/**
 * Identifies the Twitch user behind a freshly-exchanged user access token via Helix `GET /users`. Shared by
 * both Twitch chat-bot connect flows (`routes/oauth-integrations.ts`'s `twitch_chat` branch identifies the
 * broadcaster; its `twitch_bot` branch identifies Pavisie's own bot account) — same call, different purpose.
 */
export async function identifyTwitchUser(accessToken: string): Promise<TwitchHelixUser> {
  const clientId = env.TWITCH_CLIENT_ID;
  if (!clientId) {
    throw new ExternalServiceError('Twitch is not configured on this server.');
  }
  const res = await fetch('https://api.twitch.tv/helix/users', {
    headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId },
  });
  if (!res.ok) {
    throw new ExternalServiceError(`Twitch user lookup failed (${res.status}).`);
  }
  const json = (await res.json()) as RawTwitchUsersResponse;
  const user = json.data?.[0];
  if (!user) {
    throw new ExternalServiceError('Twitch user lookup returned no user.');
  }
  return { id: user.id, login: user.login, displayName: user.display_name };
}

// ---------------------------------------------------------------------------
// Setup-page provider availability (ARCHITECTURE.md's integrations connector spec: "GET /guilds/:id/integrations
// returns availability per provider"). This uses the canonical provider-id set from `@pavisie/types/integrations`
// (matching what `/integration connect`/`alerts add` accept and the `IntegrationProvider` Prisma enum, lowercased)
// rather than this file's own `IntegrationProviderId` (which only covers the oauth/webhook connect flow above and
// predates youtube/steam being addressable at all — they connect only via `POST .../integrations/alerts`).
// -----------------------------------------------------------------------------

interface ProviderMeta {
  id: CanonicalProviderId;
  name: string;
  kind: IntegrationProviderKind;
  requiredEnv: string[];
}

const PROVIDER_META: Record<CanonicalProviderId, ProviderMeta> = {
  twitch: {
    id: 'twitch',
    name: 'Twitch',
    kind: 'oauth',
    requiredEnv: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'],
  },
  youtube: { id: 'youtube', name: 'YouTube', kind: 'apikey', requiredEnv: ['YOUTUBE_API_KEY'] },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    kind: 'oauth',
    requiredEnv: ['INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET'],
  },
  reddit: {
    id: 'reddit',
    name: 'Reddit',
    kind: 'apikey',
    requiredEnv: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'],
  },
  steam: { id: 'steam', name: 'Steam', kind: 'public', requiredEnv: ['STEAM_API_KEY'] },
  google_calendar: {
    id: 'google_calendar',
    name: 'Google Calendar',
    kind: 'oauth',
    requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  },
  microsoft_calendar: {
    id: 'microsoft_calendar',
    name: 'Microsoft 365 Calendar',
    kind: 'oauth',
    requiredEnv: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
  },
  generic_webhook: { id: 'generic_webhook', name: 'Generic webhook', kind: 'webhook', requiredEnv: [] },
};

const ALERT_CAPABLE: ReadonlySet<CanonicalProviderId> = new Set(['twitch', 'youtube', 'reddit', 'steam']);
export type AlertProviderId = 'twitch' | 'youtube' | 'reddit' | 'steam';
export const ALERT_PROVIDER_IDS: readonly AlertProviderId[] = ['twitch', 'youtube', 'reddit', 'steam'];

/** Canonical-id (`@pavisie/types/integrations`) -> Prisma `IntegrationProvider` enum, covering every provider
 * (unlike `PROVIDER_ENUM_MAP` above, which only covers the ids the oauth/webhook connect flow uses). */
export const CANONICAL_PROVIDER_ENUM_MAP: Record<CanonicalProviderId, IntegrationProvider> = {
  twitch: 'TWITCH',
  youtube: 'YOUTUBE',
  instagram: 'INSTAGRAM',
  reddit: 'REDDIT',
  steam: 'STEAM',
  google_calendar: 'GOOGLE_CALENDAR',
  microsoft_calendar: 'MICROSOFT_CALENDAR',
  generic_webhook: 'GENERIC_WEBHOOK',
};

/** Per-provider availability for the dashboard's setup hints (which env vars the operator must still set). */
export function listProviderAvailability(): IntegrationProviderInfoDto[] {
  return INTEGRATION_PROVIDER_IDS.map((id) => {
    const meta = PROVIDER_META[id];
    const missingEnv = meta.requiredEnv.filter((key) => !env[key as keyof typeof env]);
    return {
      id: meta.id,
      name: meta.name,
      kind: meta.kind,
      available: missingEnv.length === 0,
      missingEnv,
      supportsAlerts: ALERT_CAPABLE.has(id),
    };
  });
}
