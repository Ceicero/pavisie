import { createHash } from 'node:crypto';
import type { WebhookEndpoint } from '@pavisie/database';
import { assertPublicHttpUrl, decryptSecret, SsrfError } from '@pavisie/core';
import type { PluginContext } from '../sdk';
import { OUTBOUND_AUTO_DISABLE_THRESHOLD, signOutboundPayload } from './signing';

const DELIVERY_TIMEOUT_MS = 10_000;

export interface OutboundDeliveryResult {
  delivered: boolean;
  status?: number;
  error?: string;
}

function extractEventType(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'event' in payload) {
    const value = (payload as { event: unknown }).event;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return 'custom';
}

function hashPayload(payload: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  } catch {
    return createHash('sha256').update(String(payload)).digest('hex');
  }
}

/**
 * One HTTP delivery attempt of `payload` to `endpoint.url`, re-validating the URL against SSRF just before
 * sending (ARCHITECTURE.md's integrations connector spec: "URL validated with core assertPublicHttpUrl at
 * creation AND before each send"). Records a `WebhookDelivery` row and updates `failureCount`/`lastDeliveryAt`/
 * auto-disable, and emits `webhook.deliveryFailed` on failure — used by both `sendOutbound`'s immediate test path
 * and the retrying `integrations:outbound` queue processor, so every attempt (sync or queued) is recorded the
 * same way.
 */
export async function attemptOutboundDelivery(
  ctx: PluginContext,
  endpoint: WebhookEndpoint,
  payload: unknown,
  attempt: number,
): Promise<OutboundDeliveryResult> {
  if (!endpoint.url) {
    return { delivered: false, error: 'Webhook endpoint has no URL configured.' };
  }

  let result: OutboundDeliveryResult;
  try {
    await assertPublicHttpUrl(endpoint.url);

    const secret = decryptSecret(endpoint.secretEnc);
    const eventType = extractEventType(payload);
    const signed = signOutboundPayload(payload, secret, eventType);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: signed.headers,
        body: signed.body,
        signal: controller.signal,
        redirect: 'manual',
      });
      const ok = res.status >= 200 && res.status < 300;
      result =
        res.status >= 300 && res.status < 400
          ? {
              delivered: false,
              status: res.status,
              error: `Received redirect (HTTP ${res.status}), redirects are not followed.`,
            }
          : ok
            ? { delivered: true, status: res.status }
            : { delivered: false, status: res.status, error: `Received HTTP ${res.status}.` };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const message = err instanceof SsrfError ? err.message : err instanceof Error ? err.message : String(err);
    result = { delivered: false, error: message };
  }

  await ctx.prisma.webhookDelivery.create({
    data: {
      endpointId: endpoint.id,
      direction: 'OUTBOUND',
      status: result.status ?? null,
      success: result.delivered,
      attempt,
      error: result.error ?? null,
      payloadHash: hashPayload(payload),
    },
  });

  if (result.delivered) {
    await ctx.prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { lastDeliveryAt: new Date(), failureCount: 0 },
    });
  } else {
    const updated = await ctx.prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { failureCount: { increment: 1 } },
    });
    ctx.events.emit('webhook.deliveryFailed', {
      guildId: endpoint.guildId,
      endpointId: endpoint.id,
      status: result.status,
      error: result.error ?? 'Delivery failed.',
    });
    if (updated.failureCount >= OUTBOUND_AUTO_DISABLE_THRESHOLD && updated.enabled) {
      await ctx.prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { enabled: false } });
      ctx.logger.warn(
        { endpointId: endpoint.id, guildId: endpoint.guildId },
        'integrations: outbound endpoint auto-disabled after repeated failures',
      );
    }
  }

  return result;
}
