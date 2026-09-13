// Maps Prisma rows to `@pavisie/types` `OwnerMetrics*` DTOs, mirroring the convention in
// `apps/api/src/lib/developer-reports/dto.ts`.
import type {
  DataRequest,
  Guild,
  IntegrationConnection,
  ScheduledJob,
  WebhookDelivery,
  WebhookEndpoint,
} from '@pavisie/database';
import type { OwnerMetricsErrorDto, OwnerMetricsGuildDto } from '@pavisie/types';
import { buildGuildIconUrl } from '../discord';

/** Defensive cap — an error/status message from an integration provider or job payload could be arbitrarily long. */
const ERROR_MESSAGE_MAX_CHARS = 500;

function capMessage(message: string): string {
  return message.length > ERROR_MESSAGE_MAX_CHARS
    ? `${message.slice(0, ERROR_MESSAGE_MAX_CHARS)}…`
    : message;
}

/** Per-guild aggregates batched separately (groupBy over the page's guild ids) and joined in here — see `routes/owner-metrics.ts`. */
export interface OwnerMetricsGuildAggregates {
  pluginsEnabled: number;
  moderationCases30d: number;
  ticketsOpen: number;
  lastActivityAt: Date | null;
}

export function toOwnerMetricsGuildDto(row: Guild, agg: OwnerMetricsGuildAggregates): OwnerMetricsGuildDto {
  return {
    id: row.id,
    name: row.name,
    iconUrl: buildGuildIconUrl(row.id, row.iconHash),
    memberCount: row.memberCount,
    ownerId: row.ownerId,
    botPresent: row.botPresent,
    joinedAt: row.joinedAt.toISOString(),
    leftAt: row.leftAt ? row.leftAt.toISOString() : null,
    pluginsEnabled: agg.pluginsEnabled,
    moderationCases30d: agg.moderationCases30d,
    ticketsOpen: agg.ticketsOpen,
    lastActivityAt: agg.lastActivityAt ? agg.lastActivityAt.toISOString() : null,
  };
}

export function toIntegrationErrorDto(
  row: IntegrationConnection & { guild: { name: string } | null },
): OwnerMetricsErrorDto {
  return {
    id: `integration:${row.id}`,
    source: 'integration',
    guildId: row.guildId,
    guildName: row.guild?.name ?? null,
    message: capMessage(row.lastError ?? ''),
    // No dedicated `lastErrorAt` column — `updatedAt` is touched by the same write that sets `lastError`
    // (every connection-sync/token-refresh path that sets `lastError` goes through `.update()`, which stamps
    // `@updatedAt` regardless of which fields changed), so it's the closest available proxy.
    occurredAt: row.updatedAt.toISOString(),
    context: {
      provider: row.provider,
      label: row.label,
      status: row.status,
      externalAccountName: row.externalAccountName,
    },
  };
}

export function toJobErrorDto(row: ScheduledJob & { guild: { name: string } | null }): OwnerMetricsErrorDto {
  return {
    id: `job:${row.id}`,
    source: 'job',
    guildId: row.guildId,
    guildName: row.guild?.name ?? null,
    message: capMessage(row.lastError ?? ''),
    // Same `updatedAt`-as-proxy reasoning as `toIntegrationErrorDto` — no dedicated timestamp for the error.
    occurredAt: row.updatedAt.toISOString(),
    context: { jobType: row.type, pluginId: row.pluginId, attempts: row.attempts, status: row.status },
  };
}

export function toWebhookErrorDto(
  row: WebhookDelivery & { endpoint: WebhookEndpoint & { guild: { name: string } | null } },
): OwnerMetricsErrorDto {
  return {
    id: `webhook:${row.id}`,
    source: 'webhook',
    guildId: row.endpoint.guildId,
    guildName: row.endpoint.guild?.name ?? null,
    message: capMessage(row.error ?? ''),
    // `WebhookDelivery` has no `updatedAt` — each attempt is its own append-only row, so `createdAt` is exact.
    occurredAt: row.createdAt.toISOString(),
    context: {
      endpointId: row.endpointId,
      direction: row.direction,
      provider: row.endpoint.provider,
      httpStatus: row.status,
      attempt: row.attempt,
    },
  };
}

export function toDataRequestErrorDto(row: DataRequest & { guild: { name: string } | null }): OwnerMetricsErrorDto {
  return {
    id: `data-request:${row.id}`,
    source: 'data-request',
    guildId: row.guildId,
    guildName: row.guild?.name ?? null,
    message: capMessage(row.error ?? ''),
    // Same `updatedAt`-as-proxy reasoning as `toIntegrationErrorDto`: a failed request's `completedAt` is
    // never set (only the DONE path sets it), so `updatedAt` is the only timestamp that moves on failure.
    occurredAt: row.updatedAt.toISOString(),
    context: { requestType: row.type, status: row.status, requestedBy: row.requestedBy },
  };
}
