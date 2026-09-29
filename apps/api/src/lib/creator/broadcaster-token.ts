import { encryptSecret } from '@pavisie/core';
import type { PrismaClient } from '@pavisie/database';
import { TWITCH_REDEMPTIONS_SCOPE } from '@pavisie/plugins/integrations/twitch-chat/broadcaster-token';
import type { ExchangedProviderToken } from '../integrations/providers';

export { TWITCH_REDEMPTIONS_SCOPE };

/**
 * Stores (replacing any previous one) the broadcaster's own Twitch token for a channel — the token channel-point
 * rewards need (`TwitchBroadcasterToken`, ARCHITECTURE.md §19b/§19e). Used by BOTH authorize flows that yield one:
 * the Discord dashboard's connect/re-link callback and the creator dashboard's "enable channel points".
 *
 * A grant that does NOT carry `channel:read:redemptions` (or has no refresh token / expiry — Twitch always sends
 * both for this grant, so their absence means something is wrong and the token could never be refreshed) is of no
 * use for rewards, so it is NOT stored; and because a re-authorization replaces the previous grant wholesale, any
 * token already held for the channel is dropped. Returns whether a usable token is now stored.
 *
 * The token is encrypted here and never logged.
 */
export async function storeBroadcasterToken(
  prisma: PrismaClient,
  channelId: string,
  token: ExchangedProviderToken,
): Promise<boolean> {
  const usable = token.scopes.includes(TWITCH_REDEMPTIONS_SCOPE) && Boolean(token.refreshToken) && Boolean(token.expiresIn);
  if (!usable) {
    await prisma.twitchBroadcasterToken.deleteMany({ where: { channelId } });
    return false;
  }

  const data = {
    accessTokenEnc: encryptSecret(token.accessToken),
    refreshTokenEnc: encryptSecret(token.refreshToken!),
    scopes: token.scopes,
    expiresAt: new Date(Date.now() + token.expiresIn! * 1000),
    rotatedAt: null,
    status: 'CONNECTED' as const,
    lastError: null,
  };
  await prisma.twitchBroadcasterToken.upsert({
    where: { channelId },
    create: { channelId, ...data },
    update: data,
  });
  return true;
}
