import { randomBytes } from 'node:crypto';
import type { IntegrationConnection, Prisma, WebhookEndpoint } from '@pavisie/database';
import { AuditAction, ValidationError, assertPublicHttpUrl, encryptSecret } from '@pavisie/core';
import type { AlertProviderId } from '@pavisie/types/integrations';
import type { PluginContext } from '../sdk';
import { ensureTwitchEventSub } from './providers/twitch';
import { getProvider, isProviderEnvSatisfied, PROVIDER_ENUM_MAP } from './providers';
import { OUTBOUND_PLATFORM_EVENTS } from './service';

export interface CreateAlertConnectionInput {
  provider: AlertProviderId;
  target: string;
  channelId: string;
  roleId?: string | null;
  template?: string | null;
}

/** Creates one alert-watch connection (`/integration alerts add`, `POST .../integrations/alerts`): one
 * `IntegrationConnection` row per watched target (ARCHITECTURE.md §8's schema comment on `IntegrationConnection`). */
export async function createAlertConnection(
  ctx: PluginContext,
  guildId: string,
  actorId: string,
  source: 'bot' | 'dashboard',
  input: CreateAlertConnectionInput,
): Promise<IntegrationConnection> {
  const providerDef = getProvider(input.provider);
  if (!providerDef) throw new ValidationError(`Unknown provider "${input.provider}".`);

  const parsed = providerDef.configSchema.parse({
    target: input.target,
    channelId: input.channelId,
    roleId: input.roleId ?? null,
    template: input.template ?? null,
  }) as Record<string, unknown>;

  const available = isProviderEnvSatisfied(providerDef.requiredEnv, ctx.env);

  const connection = await ctx.prisma.integrationConnection.create({
    data: {
      guildId,
      provider: PROVIDER_ENUM_MAP[input.provider],
      label: input.target,
      status: available ? 'CONNECTED' : 'ERROR',
      config: parsed as Prisma.InputJsonValue,
      connectedBy: actorId,
      lastError: available ? null : `Missing environment variable(s): ${providerDef.requiredEnv.join(', ')}.`,
    },
  });

  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: AuditAction.IntegrationConnect,
    targetType: 'integration_connection',
    targetId: connection.id,
    after: { provider: input.provider, target: input.target, channelId: input.channelId },
    source,
  });

  if (input.provider === 'twitch' && available) {
    await ensureTwitchEventSub(ctx, connection).catch((err) =>
      ctx.logger.warn({ err }, 'integrations: initial Twitch EventSub setup failed'),
    );
  }

  return connection;
}

/** Soft-disconnects a connection: marks it DISCONNECTED, drops any OAuth token, and clears the pending EventSub
 * id (twitch) so a future reconnect starts clean. Never deletes the row (audit history stays intact). */
export async function disconnectConnection(
  ctx: PluginContext,
  guildId: string,
  connectionId: string,
  actorId: string,
  source: 'bot' | 'dashboard',
): Promise<IntegrationConnection> {
  const existing = await ctx.prisma.integrationConnection.findFirst({
    where: { id: connectionId, guildId, deletedAt: null },
  });
  if (!existing) throw new ValidationError('Integration connection not found.');

  const updated = await ctx.prisma.integrationConnection.update({
    where: { id: connectionId },
    data: { status: 'DISCONNECTED' },
  });
  await ctx.prisma.oAuthToken.deleteMany({ where: { connectionId } });

  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: AuditAction.IntegrationDisconnect,
    targetType: 'integration_connection',
    targetId: connectionId,
    before: { status: existing.status },
    source,
  });

  return updated;
}

export interface CreateInboundWebhookInput {
  name: string;
  provider?: string;
  channelId?: string | null;
  /** Optional message template (`{dot.path}` placeholders) for the `generic` provider only. */
  template?: string | null;
}

export interface CreatedInboundWebhook {
  endpoint: WebhookEndpoint;
  secret: string;
}

/** Creates an inbound `WebhookEndpoint`, returning its plaintext secret exactly once (never retrievable again). */
export async function createInboundWebhook(
  ctx: PluginContext,
  guildId: string,
  actorId: string,
  source: 'bot' | 'dashboard',
  input: CreateInboundWebhookInput,
): Promise<CreatedInboundWebhook> {
  const secret = randomBytes(32).toString('hex');
  const provider = input.provider ?? 'generic';
  const events = provider === 'generic' && input.template ? [input.template] : [];

  const endpoint = await ctx.prisma.webhookEndpoint.create({
    data: {
      guildId,
      direction: 'INBOUND',
      provider,
      name: input.name,
      events,
      channelId: input.channelId ?? null,
      secretEnc: encryptSecret(secret),
    },
  });

  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: AuditAction.IntegrationWebhookCreate,
    targetType: 'webhook_endpoint',
    targetId: endpoint.id,
    after: { name: endpoint.name, provider: endpoint.provider, direction: 'inbound' },
    source,
  });

  return { endpoint, secret };
}

export interface CreateOutboundWebhookInput {
  name: string;
  url: string;
  events: string[];
}

export async function createOutboundWebhook(
  ctx: PluginContext,
  guildId: string,
  actorId: string,
  source: 'bot' | 'dashboard',
  input: CreateOutboundWebhookInput,
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  await assertPublicHttpUrl(input.url); // validated at creation (and again before every send, see delivery.ts)

  const invalidEvents = input.events.filter(
    (e) => !(OUTBOUND_PLATFORM_EVENTS as readonly string[]).includes(e),
  );
  if (invalidEvents.length > 0) {
    throw new ValidationError(
      `Unknown event(s): ${invalidEvents.join(', ')}. Valid events: ${OUTBOUND_PLATFORM_EVENTS.join(', ')}.`,
    );
  }
  if (input.events.length === 0) {
    throw new ValidationError('At least one event is required.');
  }

  const secret = randomBytes(32).toString('hex');
  const endpoint = await ctx.prisma.webhookEndpoint.create({
    data: {
      guildId,
      direction: 'OUTBOUND',
      provider: 'generic',
      name: input.name,
      url: input.url,
      events: input.events,
      secretEnc: encryptSecret(secret),
    },
  });

  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: AuditAction.IntegrationWebhookCreate,
    targetType: 'webhook_endpoint',
    targetId: endpoint.id,
    after: { name: endpoint.name, events: endpoint.events, direction: 'outbound' },
    source,
  });

  return { endpoint, secret };
}

export async function deleteWebhookEndpoint(
  ctx: PluginContext,
  guildId: string,
  endpointId: string,
  actorId: string,
  source: 'bot' | 'dashboard',
): Promise<void> {
  const existing = await ctx.prisma.webhookEndpoint.findFirst({
    where: { id: endpointId, guildId, deletedAt: null },
  });
  if (!existing) throw new ValidationError('Webhook endpoint not found.');

  await ctx.prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: { deletedAt: new Date(), enabled: false },
  });
  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: AuditAction.IntegrationWebhookDelete,
    targetType: 'webhook_endpoint',
    targetId: endpointId,
    source,
  });
}
