// Discord <-> Twitch chat bridge — webhook provisioning for the Twitch -> Discord relay direction. Runs in the
// bot process only (discord.js + Prisma allowed here), called from `manager.ts`'s `runBridgeReconcile`.
import { PermissionFlagsBits, WebhookClient, type Guild } from 'discord.js';
import type { TwitchChatChannel } from '@pavisie/database';
import { decryptSecret, encryptSecret } from '@pavisie/core';
import type { PluginContext } from '../../sdk';

const BRIDGE_REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ManageWebhooks,
] as const;

/** Discord's own webhook-not-found error code (a webhook that was deleted from Discord's side, e.g. by an
 * admin cleaning up "Integrations"), used by `manager.ts` to know when to self-heal via `clearBridgeWebhook`. */
export const UNKNOWN_WEBHOOK_ERROR_CODE = 10015;

export type BridgeAccessCheckResult = { ok: true } | { ok: false; error: string };

/**
 * Confirms the bridge Discord channel exists, is text-based, and that the bot has View Channel + Send Messages
 * + Manage Webhooks there. Returns a clear, non-sensitive error string on any failure — never a raw exception
 * message — so it's safe to persist to `TwitchChatChannel.bridgeLastError` and surface in the dashboard/command.
 */
export async function checkBridgeChannelAccess(guild: Guild, channelId: string): Promise<BridgeAccessCheckResult> {
  let channel;
  try {
    channel = await guild.channels.fetch(channelId);
  } catch {
    return { ok: false, error: 'The bridge Discord channel could not be found.' };
  }
  if (!channel || !channel.isTextBased()) {
    return { ok: false, error: 'The bridge Discord channel must be a text channel.' };
  }

  const botMember = guild.members.me;
  if (!botMember) {
    return { ok: false, error: "Pavisie's own member could not be resolved in this server." };
  }

  const perms = channel.permissionsFor(botMember);
  if (!perms || !perms.has(BRIDGE_REQUIRED_PERMISSIONS)) {
    return {
      ok: false,
      error:
        'Pavisie needs View Channel, Send Messages, and Manage Webhooks in the bridge Discord channel.',
    };
  }

  return { ok: true };
}

export type EnsureBridgeWebhookResult = { ok: true; client: WebhookClient } | { ok: false; error: string };

/**
 * Returns a `WebhookClient` for `channel`'s bridge webhook, creating (and persisting, token encrypted at rest)
 * a new one if none exists yet or the stored credential can't be decrypted. Never throws — every failure comes
 * back as `{ ok: false, error }`.
 */
export async function ensureBridgeWebhook(
  ctx: PluginContext,
  guild: Guild,
  channel: TwitchChatChannel,
): Promise<EnsureBridgeWebhookResult> {
  if (channel.bridgeWebhookId && channel.bridgeWebhookTokenEnc) {
    try {
      const token = decryptSecret(channel.bridgeWebhookTokenEnc);
      return { ok: true, client: new WebhookClient({ id: channel.bridgeWebhookId, token }) };
    } catch {
      // Falls through to recreate — a corrupt/undecryptable stored token (e.g. a rotated ENCRYPTION_KEY) can
      // never succeed on retry, so a fresh webhook is the only way forward.
    }
  }

  if (!channel.bridgeDiscordChannelId) {
    return { ok: false, error: 'No bridge Discord channel is configured.' };
  }

  let discordChannel;
  try {
    discordChannel = await guild.channels.fetch(channel.bridgeDiscordChannelId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not fetch the bridge Discord channel: ${message}` };
  }
  if (!discordChannel || !('createWebhook' in discordChannel)) {
    return { ok: false, error: 'The bridge Discord channel does not support webhooks.' };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrowed above via `'createWebhook' in discordChannel`; discord.js doesn't expose a single named union type for "every channel kind that supports createWebhook".
    const webhook = await (discordChannel as any).createWebhook({ name: 'Pavisie Twitch Bridge' });
    await ctx.prisma.twitchChatChannel.update({
      where: { id: channel.id },
      data: { bridgeWebhookId: webhook.id, bridgeWebhookTokenEnc: encryptSecret(webhook.token as string) },
    });
    return { ok: true, client: new WebhookClient({ id: webhook.id, token: webhook.token as string }) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not create the bridge webhook: ${message}` };
  }
}

/** Best-effort: clears a channel's stored bridge webhook credential so the next reconcile recreates it. Called
 * when a send comes back "Unknown Webhook" (the webhook was deleted from Discord's side). Swallows errors, same
 * `.catch(() => undefined)` convention used everywhere else in `manager.ts`. */
export async function clearBridgeWebhook(ctx: PluginContext, channelId: string): Promise<void> {
  await ctx.prisma.twitchChatChannel
    .update({ where: { id: channelId }, data: { bridgeWebhookId: null, bridgeWebhookTokenEnc: null } })
    .catch(() => undefined);
}
