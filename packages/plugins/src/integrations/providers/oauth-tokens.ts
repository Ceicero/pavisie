import type { IntegrationConnection, OAuthToken } from '@pavisie/database';
import { decryptSecret, encryptSecret } from '@pavisie/core';
import type { PluginContext } from '../../sdk';

/** Provider ids whose bot-side jobs need to refresh a user-authorized OAuth token at all (twitch/reddit poll
 * with an app-level client-credentials token instead, see `twitch.ts`/`reddit.ts`, so they aren't here).
 * `google_calendar`/`microsoft_calendar` use the standard refresh_token grant (`OAUTH_REFRESH_META` below);
 * `instagram` is special-cased in `refreshOAuthToken` because Instagram's API never issues a separate refresh
 * token at all — see the comment on `refreshInstagramToken`. */
export type OAuthRefreshableProviderId = 'google_calendar' | 'microsoft_calendar' | 'instagram';

/** Token endpoint + client-credential env var names for the two *standard* refresh_token-grant providers. */
export interface OAuthRefreshMeta {
  tokenUrl: string;
  clientIdEnv: 'GOOGLE_CLIENT_ID' | 'MICROSOFT_CLIENT_ID';
  clientSecretEnv: 'GOOGLE_CLIENT_SECRET' | 'MICROSOFT_CLIENT_SECRET';
  authStyle: 'body' | 'basic';
}

export const OAUTH_REFRESH_META: Record<'google_calendar' | 'microsoft_calendar', OAuthRefreshMeta> = {
  google_calendar: {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    authStyle: 'body',
  },
  microsoft_calendar: {
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientIdEnv: 'MICROSOFT_CLIENT_ID',
    clientSecretEnv: 'MICROSOFT_CLIENT_SECRET',
    authStyle: 'body',
  },
};

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface InstagramRefreshResponse {
  access_token: string;
  expires_in?: number;
}

/**
 * Instagram API with Instagram Login has no `refresh_token` grant and hands out no separate refresh token at
 * all (see `oauth-integrations.ts`'s exchange of the code for an already-long-lived token) — a long-lived
 * access token refreshes *itself*: `GET https://graph.instagram.com/refresh_access_token` bearing the current
 * token, no client id/secret involved. `refreshTokenEnc` is therefore never populated for this provider; the
 * current `accessTokenEnc` doubles as the refresh credential. Returns the new plaintext access token, or `null`
 * if the request failed.
 */
async function refreshInstagramToken(ctx: PluginContext, token: OAuthToken): Promise<string | null> {
  const currentAccessToken = decryptSecret(token.accessTokenEnc);
  const params = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: currentAccessToken });

  try {
    const res = await fetch(`https://graph.instagram.com/refresh_access_token?${params.toString()}`);
    if (!res.ok) {
      ctx.logger.warn({ status: res.status, provider: 'instagram' }, 'integrations: token refresh failed');
      return null;
    }
    const json = (await res.json()) as InstagramRefreshResponse;

    await ctx.prisma.oAuthToken.update({
      where: { id: token.id },
      data: {
        accessTokenEnc: encryptSecret(json.access_token),
        expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
        rotatedAt: new Date(),
      },
    });

    return json.access_token;
  } catch (err) {
    ctx.logger.warn({ err, provider: 'instagram' }, 'integrations: token refresh request threw');
    return null;
  }
}

/** Refreshes one `OAuthToken` row in place. `instagram` is special-cased to Meta's own re-issue-by-current-token
 * scheme (`refreshInstagramToken`); `google_calendar`/`microsoft_calendar` use the standard refresh_token grant
 * via `OAUTH_REFRESH_META`. Returns the new plaintext access token, or `null` if there's no refresh token to use
 * (or none needed, for instagram) or the refresh request failed. */
export async function refreshOAuthToken(
  ctx: PluginContext,
  providerId: OAuthRefreshableProviderId,
  token: OAuthToken,
): Promise<string | null> {
  if (providerId === 'instagram') {
    return refreshInstagramToken(ctx, token);
  }

  if (!token.refreshTokenEnc) return null;
  const meta = OAUTH_REFRESH_META[providerId];
  const clientId = ctx.env[meta.clientIdEnv];
  const clientSecret = ctx.env[meta.clientSecretEnv];
  if (!clientId || !clientSecret) return null;

  const refreshToken = decryptSecret(token.refreshTokenEnc);
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (meta.authStyle === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
  }

  try {
    const res = await fetch(meta.tokenUrl, { method: 'POST', headers, body });
    if (!res.ok) {
      ctx.logger.warn({ status: res.status, provider: providerId }, 'integrations: token refresh failed');
      return null;
    }
    const json = (await res.json()) as RawTokenResponse;

    await ctx.prisma.oAuthToken.update({
      where: { id: token.id },
      data: {
        accessTokenEnc: encryptSecret(json.access_token),
        refreshTokenEnc: json.refresh_token ? encryptSecret(json.refresh_token) : undefined,
        expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
        rotatedAt: new Date(),
      },
    });

    return json.access_token;
  } catch (err) {
    ctx.logger.warn({ err, provider: providerId }, 'integrations: token refresh request threw');
    return null;
  }
}

/** Returns a valid (refreshing first if it's expired or expiring within `skewMs`) decrypted access token for
 * `connection`, or `null` if there's no token row, no refresh token, or the refresh failed. */
export async function getValidAccessToken(
  ctx: PluginContext,
  providerId: OAuthRefreshableProviderId,
  connection: IntegrationConnection,
  skewMs = 60_000,
): Promise<string | null> {
  const token = await ctx.prisma.oAuthToken.findUnique({ where: { connectionId: connection.id } });
  if (!token) return null;

  const expiringSoon = token.expiresAt ? token.expiresAt.getTime() - Date.now() < skewMs : false;
  if (!expiringSoon) {
    return decryptSecret(token.accessTokenEnc);
  }
  return refreshOAuthToken(ctx, providerId, token);
}
