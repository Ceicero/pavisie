// The Discord <-> Twitch chat bridge's validation and webhook tidying, used by the creator dashboard's bridge route
// (`routes/creator-twitch-discord.ts`, ARCHITECTURE.md §19e) and by the unlink flow (`lib/creator/discord-link.ts`,
// which the Discord dashboard's Unlink also uses). Since phase 4 the bridge is configured ONLY from the creator
// dashboard.
import type { TwitchChatChannel } from '@pavisie/database';
import { ValidationError, decryptSecret } from '@pavisie/core';
import type { ZodFastifyInstance } from '../http';
import { getCachedGuildChannels } from '../discord';

/**
 * Best-effort delete of a Discord <-> Twitch bridge webhook, called right before its stored credential is
 * cleared because the bridge Discord channel is changing/being cleared. Discord's `DELETE /webhooks/{id}/
 * {token}` endpoint authenticates via the webhook's own token in the URL — no bot `Authorization` header or
 * live discord.js client needed, so a plain `fetch` works fine from this process. Never throws: a failed delete
 * (webhook already gone, network hiccup, Discord downtime) must never block the actual field-clearing update
 * that follows it, since that update is what matters for correctness — this is pure tidiness.
 */
export async function deleteBridgeWebhookBestEffort(webhookId: string, webhookTokenEnc: string): Promise<void> {
  try {
    const token = decryptSecret(webhookTokenEnc);
    // Time-boxed: this runs before the settings update is saved, so a hung Discord request must not hang the save.
    await fetch(`https://discord.com/api/v10/webhooks/${webhookId}/${token}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Swallowed on purpose — see doc comment above.
  }
}

/** The bridge fields of an update request (the guild route's channel PATCH and the creator bridge PATCH share them). */
export interface BridgePatch {
  bridgeDiscordChannelId?: string | null;
  bridgeDiscordToTwitch?: boolean;
  bridgeTwitchToDiscord?: boolean;
}

/**
 * Validates a bridge update against the existing row and returns the Prisma `data` fragment to write.
 *
 * Best the API process can honestly check without a live discord.js client is that the channel exists in the
 * (linked) guild and is a text-capable type. The REAL permission check (View Channel / Send Messages / Manage
 * Webhooks) only the bot process can do, during its reconcile pass (`runBridgeReconcile`) — failures there are
 * reported back via `bridgeLastError`. The *resulting* state (existing row merged with this patch) is validated too:
 * a direction toggle can never end up `true` with no bridge channel set. When the bridge channel is changing or
 * being cleared, the OLD webhook is deleted from Discord best-effort and the stored credential nulled, so it does
 * not sit in the old channel's "Integrations" list forever (not load-bearing: the bot creates a fresh webhook in the
 * new channel on its next reconcile either way).
 */
export async function prepareBridgeUpdate(
  app: ZodFastifyInstance,
  guildId: string,
  existing: TwitchChatChannel,
  body: BridgePatch,
): Promise<Record<string, unknown>> {
  if (body.bridgeDiscordChannelId !== undefined && body.bridgeDiscordChannelId !== null) {
    const channels = await getCachedGuildChannels(app.redis, guildId);
    const match = channels.find((c) => c.id === body.bridgeDiscordChannelId);
    if (!match) throw new ValidationError('That channel was not found in this server.');
    if (match.type !== 0 && match.type !== 5) {
      throw new ValidationError('The bridge channel must be a text channel.');
    }
  }

  const resultingChannelId =
    body.bridgeDiscordChannelId !== undefined ? body.bridgeDiscordChannelId : existing.bridgeDiscordChannelId;
  const resultingDiscordToTwitch =
    body.bridgeDiscordToTwitch !== undefined ? body.bridgeDiscordToTwitch : existing.bridgeDiscordToTwitch;
  const resultingTwitchToDiscord =
    body.bridgeTwitchToDiscord !== undefined ? body.bridgeTwitchToDiscord : existing.bridgeTwitchToDiscord;
  if ((resultingDiscordToTwitch || resultingTwitchToDiscord) && !resultingChannelId) {
    throw new ValidationError('Pick a Discord channel before turning on the bridge.');
  }

  const channelIsChanging =
    body.bridgeDiscordChannelId !== undefined && body.bridgeDiscordChannelId !== existing.bridgeDiscordChannelId;
  if (channelIsChanging && existing.bridgeWebhookId && existing.bridgeWebhookTokenEnc) {
    await deleteBridgeWebhookBestEffort(existing.bridgeWebhookId, existing.bridgeWebhookTokenEnc);
  }

  return {
    ...(body.bridgeDiscordChannelId !== undefined ? { bridgeDiscordChannelId: body.bridgeDiscordChannelId } : {}),
    ...(body.bridgeDiscordToTwitch !== undefined ? { bridgeDiscordToTwitch: body.bridgeDiscordToTwitch } : {}),
    ...(body.bridgeTwitchToDiscord !== undefined ? { bridgeTwitchToDiscord: body.bridgeTwitchToDiscord } : {}),
    ...(channelIsChanging ? { bridgeWebhookId: null, bridgeWebhookTokenEnc: null, bridgeLastError: null } : {}),
  };
}
