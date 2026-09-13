import { OUTBOUND_PLATFORM_EVENTS, type OutboundPlatformEvent } from '@pavisie/types/integrations';
import type { IntegrationsService } from '../sdk';
import type { PluginContext } from '../sdk';
import { attemptOutboundDelivery } from './delivery';
import { OUTBOUND_JOB_OPTIONS } from './signing';

export { OUTBOUND_PLATFORM_EVENTS, type OutboundPlatformEvent };

/** Fans a platform event out to every matching enabled OUTBOUND `WebhookEndpoint` in `guildId`, enqueueing a
 * signed, retrying delivery job for each (never sent synchronously — see `sendOutbound` below for why). */
export async function dispatchOutboundPlatformEvent(
  ctx: PluginContext,
  eventName: OutboundPlatformEvent,
  guildId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const endpoints = await ctx.prisma.webhookEndpoint.findMany({
    where: { guildId, direction: 'OUTBOUND', enabled: true, deletedAt: null },
  });
  const matches = endpoints.filter((e) => e.events.includes(eventName));
  if (matches.length === 0) return;

  const payload = { event: eventName, guildId, timestamp: new Date().toISOString(), data };
  for (const endpoint of matches) {
    await ctx
      .queue('outbound')
      .add('deliver', { endpointId: endpoint.id, guildId, payload, attempt: 1 }, OUTBOUND_JOB_OPTIONS);
  }
}

/** Subscribes to every platform event an outbound webhook can fire on (called once from `onLoad`). */
export function registerOutboundEventBridge(ctx: PluginContext): void {
  ctx.events.on(
    'moderation.caseCreated',
    (e) => void dispatchOutboundPlatformEvent(ctx, 'moderation.caseCreated', e.guildId, { ...e }),
  );
  ctx.events.on(
    'ticket.opened',
    (e) => void dispatchOutboundPlatformEvent(ctx, 'ticket.opened', e.guildId, { ...e }),
  );
  ctx.events.on(
    'ticket.closed',
    (e) => void dispatchOutboundPlatformEvent(ctx, 'ticket.closed', e.guildId, { ...e }),
  );
  ctx.events.on(
    'member.verified',
    (e) => void dispatchOutboundPlatformEvent(ctx, 'member.verified', e.guildId, { ...e }),
  );
  ctx.events.on('level.up', (e) => void dispatchOutboundPlatformEvent(ctx, 'level.up', e.guildId, { ...e }));
  ctx.events.on(
    'automod.triggered',
    (e) => void dispatchOutboundPlatformEvent(ctx, 'automod.triggered', e.guildId, { ...e }),
  );
  ctx.events.on(
    'enforcer.decided',
    (e) => void dispatchOutboundPlatformEvent(ctx, 'enforcer.decided', e.guildId, { ...e }),
  );
}

interface BotActionJobShape {
  guildId: string;
  payload?: unknown;
  requestedBy?: string;
}

function isBotActionJobShape(value: unknown): value is BotActionJobShape {
  return typeof value === 'object' && value !== null && 'guildId' in value;
}

/**
 * Builds the `IntegrationsService` (sdk/services.ts). Both methods are tolerant of two calling conventions:
 * the documented positional one (`(guildId, endpointId)`), and `apps/bot/src/host/bot-actions.ts`'s current
 * dispatcher, which actually invokes every `ServiceMap` method with a single `{ guildId, payload, requestedBy }`
 * job object regardless of the target method's declared arity — see this plugin's README "Known limitations".
 */
export function createIntegrationsService(ctx: PluginContext): IntegrationsService {
  function resolveArgs(
    guildIdOrJob: string | BotActionJobShape,
    endpointId?: string,
  ): { guildId: string; endpointId: string } {
    if (isBotActionJobShape(guildIdOrJob)) {
      const payload = (guildIdOrJob.payload as { endpointId?: string } | undefined) ?? undefined;
      return { guildId: guildIdOrJob.guildId, endpointId: payload?.endpointId ?? '' };
    }
    return { guildId: guildIdOrJob, endpointId: endpointId ?? '' };
  }

  return {
    async sendOutbound(guildIdOrJob, endpointIdArg, payloadArg) {
      const { guildId, endpointId } = resolveArgs(
        guildIdOrJob as string | BotActionJobShape,
        endpointIdArg as string | undefined,
      );
      const endpoint = await ctx.prisma.webhookEndpoint.findFirst({
        where: { id: endpointId, guildId, direction: 'OUTBOUND', deletedAt: null },
      });
      if (!endpoint) return { delivered: false, error: 'Webhook endpoint not found.' };
      if (!endpoint.enabled) return { delivered: false, error: 'Webhook endpoint is disabled.' };

      // The 3rd positional arg (payload) only exists in the documented calling convention; the bot-actions
      // dispatcher has no way to pass one, so a job-shaped call here always sends a generic manual payload.
      const payload = isBotActionJobShape(guildIdOrJob)
        ? { event: 'integration.manual', guildId, timestamp: new Date().toISOString() }
        : payloadArg;
      await ctx
        .queue('outbound')
        .add('deliver', { endpointId: endpoint.id, guildId, payload, attempt: 1 }, OUTBOUND_JOB_OPTIONS);
      return { delivered: true };
    },

    async testWebhook(guildIdOrJob, endpointIdArg) {
      const { guildId, endpointId } = resolveArgs(
        guildIdOrJob as string | BotActionJobShape,
        endpointIdArg as string | undefined,
      );
      const endpoint = await ctx.prisma.webhookEndpoint.findFirst({
        where: { id: endpointId, guildId, direction: 'OUTBOUND', deletedAt: null },
      });
      if (!endpoint) return { delivered: false, error: 'Webhook endpoint not found.' };

      const payload = {
        event: 'integration.test',
        guildId,
        timestamp: new Date().toISOString(),
        message: 'This is a test delivery from Pavisie.',
      };
      const result = await attemptOutboundDelivery(ctx, endpoint, payload, 1);
      return { delivered: result.delivered, error: result.error };
    },
  };
}
