import { z } from 'zod';
import type { IntegrationConnection } from '@pavisie/database';
import type { PluginContext } from '../../sdk';
import { resolveTextChannel } from '../../sdk';
import { renderDefaultPayloadPreview, renderTemplate } from '../templating';
import type { IntegrationProviderDef, InboundWebhookEvent } from './types';

/** No per-connection concept — a plain `WebhookEndpoint` (INBOUND, provider `'generic'`/`'generic_webhook'`);
 * documented for completeness only, mirroring `github`'s provider. */
export const genericWebhookConfigSchema = z.object({});

async function handleGenericInbound(
  ctx: PluginContext,
  _connection: IntegrationConnection | null,
  event: InboundWebhookEvent,
): Promise<void> {
  if (!event.endpointId) return;
  const endpoint = await ctx.prisma.webhookEndpoint.findUnique({ where: { id: event.endpointId } });
  if (!endpoint || !endpoint.enabled || endpoint.deletedAt || !endpoint.channelId) return;

  // `events` on a generic inbound endpoint holds at most one entry: an optional message template (`{dot.path}`
  // placeholders into the JSON payload). No template configured -> a fenced JSON preview instead.
  const template = endpoint.events[0];
  const content = template
    ? renderTemplate(template, event.payload)
    : renderDefaultPayloadPreview(event.eventType, event.payload);

  try {
    const guild = await ctx.client.guilds.fetch(endpoint.guildId).catch(() => null);
    if (!guild) return;
    const channel = await resolveTextChannel(guild, endpoint.channelId);
    if (!channel) return;
    await channel.send({ content: content.slice(0, 2000), allowedMentions: { parse: [] } });
    await ctx.prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { lastDeliveryAt: new Date() },
    });
  } catch (err) {
    ctx.logger.warn({ err, endpointId: endpoint.id }, 'integrations/generic: failed to post inbound message');
  }
}

export const genericWebhookProvider: IntegrationProviderDef = {
  id: 'generic_webhook',
  name: 'Generic webhook',
  kind: 'webhook',
  requiredEnv: [],
  configSchema: genericWebhookConfigSchema,
  handleInbound: handleGenericInbound,
};
