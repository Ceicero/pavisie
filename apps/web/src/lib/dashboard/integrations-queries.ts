'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated } from '@pavisie/types';
import type {
  CreateAlertConnectionInput,
  CreateOutboundEndpointInput,
  IntegrationConnectionDetailDto,
  IntegrationLiveStatusDto,
  IntegrationProviderInfoDto,
  TwitchChatGuildLinksDto,
  WebhookDeliveryDto,
  WebhookEndpointDetailDto,
} from '@pavisie/types/integrations';
import { apiFetch, toQueryString } from './api';

export const integrationsQueryKeys = {
  connections: (guildId: string) => ['guilds', guildId, 'integrations', 'connections'] as const,
  live: (guildId: string) => ['guilds', guildId, 'integrations', 'live'] as const,
  providers: (guildId: string) => ['guilds', guildId, 'integrations', 'providers'] as const,
  alerts: (guildId: string, provider?: string) =>
    ['guilds', guildId, 'integrations', 'alerts', provider ?? 'all'] as const,
  inboundWebhooks: (guildId: string) => ['guilds', guildId, 'integrations', 'webhooks', 'inbound'] as const,
  outboundWebhooks: (guildId: string) => ['guilds', guildId, 'integrations', 'webhooks', 'outbound'] as const,
  deliveries: (guildId: string, endpointId: string) =>
    ['guilds', guildId, 'integrations', 'webhooks', 'outbound', endpointId, 'deliveries'] as const,
  twitchChatLinks: (guildId: string) => ['guilds', guildId, 'integrations', 'twitch-chat', 'links'] as const,
};

// ---------------------------------------------------------------------------
// Provider availability + OAuth/webhook-establishment connections
// ---------------------------------------------------------------------------

export function useIntegrationProviders(guildId: string | undefined) {
  return useQuery({
    queryKey: integrationsQueryKeys.providers(guildId ?? ''),
    queryFn: () => apiFetch<IntegrationProviderInfoDto[]>(`/guilds/${guildId}/integrations/providers`),
    enabled: Boolean(guildId),
  });
}

/** The base connection list (`GET /guilds/:id/integrations`) — every OAuth/webhook-established connection
 * (twitch/google_calendar/microsoft_calendar/instagram/reddit/generic_webhook), distinct from the per-target
 * alert watches in `useAlertConnections`. Used to show "already connected" state on provider cards. */
export function useConnections(guildId: string | undefined) {
  return useQuery({
    queryKey: integrationsQueryKeys.connections(guildId ?? ''),
    queryFn: () => apiFetch<IntegrationConnectionDetailDto[]>(`/guilds/${guildId}/integrations`),
    enabled: Boolean(guildId),
  });
}

/** Groups connections by provider id (lowercased), keeping every connection for that provider — not just the
 * first — in the order the API returned them (`createdAt: desc`). A provider absent from `connections` gets
 * no entry at all, so callers should fall back to `?? []`. This is the exact spot the multi-account dedupe bug
 * lived (a `Map` that kept only the first connection per provider via `if (!map.has(...))`); the Providers
 * grid must show every connection a guild has for a provider (several Twitch broadcasters, several Reddit
 * subreddits, ...), not cap it at one. */
export function groupConnectionsByProvider(
  connections: IntegrationConnectionDetailDto[],
): Map<string, IntegrationConnectionDetailDto[]> {
  const map = new Map<string, IntegrationConnectionDetailDto[]>();
  for (const conn of connections) {
    const key = conn.provider.toLowerCase();
    const existing = map.get(key);
    if (existing) existing.push(conn);
    else map.set(key, [conn]);
  }
  return map;
}

/** "Live now" status per connection (Twitch only today — see `apps/api/src/lib/integrations/live-status.ts`),
 * for the LIVE pill on `ProviderCard` rows. On-demand, dashboard-driven polling only (`refetchInterval`) —
 * deliberately not a background job, so an idle dashboard costs zero Twitch quota. React Query only runs this
 * while some component actually calls the hook (i.e. while this page is mounted), so navigating away stops
 * the polling on its own. */
export function useConnectionsLive(guildId: string | undefined) {
  return useQuery({
    queryKey: integrationsQueryKeys.live(guildId ?? ''),
    queryFn: () => apiFetch<IntegrationLiveStatusDto[]>(`/guilds/${guildId}/integrations/live`),
    enabled: Boolean(guildId),
    refetchInterval: 60_000,
  });
}

/** Maps a canonical provider id to the id `POST /:provider/connect` expects — that route predates the canonical
 * provider-id set and still uses its own shorthand for the two calendar providers. */
const CONNECT_ROUTE_PROVIDER_ID: Record<string, string> = {
  google_calendar: 'google',
  microsoft_calendar: 'microsoft',
};

export interface ConnectProviderResult {
  /** Present for OAuth providers — redirect the browser here to start the flow. */
  url?: string;
  /** Present for webhook-establishing providers (generic_webhook). */
  webhookUrl?: string | null;
  secret?: string;
}

export function useConnectProvider(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) =>
      apiFetch<ConnectProviderResult>(
        `/guilds/${guildId}/integrations/${CONNECT_ROUTE_PROVIDER_ID[providerId] ?? providerId}/connect`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationsQueryKeys.connections(guildId) });
    },
  });
}

export function useDisconnectConnection(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      apiFetch<void>(`/guilds/${guildId}/integrations/${connectionId}/disconnect`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationsQueryKeys.connections(guildId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Alert watches (twitch/youtube/reddit/steam)
// ---------------------------------------------------------------------------

export function useAlertConnections(guildId: string | undefined, provider?: string) {
  return useQuery({
    queryKey: integrationsQueryKeys.alerts(guildId ?? '', provider),
    queryFn: () =>
      apiFetch<IntegrationConnectionDetailDto[]>(
        `/guilds/${guildId}/integrations/alerts${toQueryString({ provider })}`,
      ),
    enabled: Boolean(guildId),
  });
}

export function useCreateAlertConnection(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAlertConnectionInput) =>
      apiFetch<IntegrationConnectionDetailDto>(`/guilds/${guildId}/integrations/alerts`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'integrations', 'alerts'] });
    },
  });
}

export function useDeleteAlertConnection(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      apiFetch<void>(`/guilds/${guildId}/integrations/alerts/${connectionId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'integrations', 'alerts'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Inbound webhooks
// ---------------------------------------------------------------------------

export function useInboundWebhooks(guildId: string | undefined) {
  return useQuery({
    queryKey: integrationsQueryKeys.inboundWebhooks(guildId ?? ''),
    queryFn: () => apiFetch<WebhookEndpointDetailDto[]>(`/guilds/${guildId}/integrations/webhooks`),
    enabled: Boolean(guildId),
  });
}

export interface CreateInboundWebhookResult extends WebhookEndpointDetailDto {
  secret: string;
  url: string;
}

export interface CreateInboundWebhookInput {
  name: string;
  provider?: string;
  channelId?: string | null;
  events?: string[];
}

export function useCreateInboundWebhook(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInboundWebhookInput) =>
      apiFetch<CreateInboundWebhookResult>(`/guilds/${guildId}/integrations/webhooks`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationsQueryKeys.inboundWebhooks(guildId) });
    },
  });
}

export function useDeleteInboundWebhook(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (endpointId: string) =>
      apiFetch<void>(`/guilds/${guildId}/integrations/webhooks/${endpointId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationsQueryKeys.inboundWebhooks(guildId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Outbound webhooks
// ---------------------------------------------------------------------------

export function useOutboundWebhooks(guildId: string | undefined) {
  return useQuery({
    queryKey: integrationsQueryKeys.outboundWebhooks(guildId ?? ''),
    queryFn: () => apiFetch<WebhookEndpointDetailDto[]>(`/guilds/${guildId}/integrations/outbound`),
    enabled: Boolean(guildId),
  });
}

export interface CreateOutboundWebhookResult extends WebhookEndpointDetailDto {
  secret: string;
}

export function useCreateOutboundWebhook(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOutboundEndpointInput) =>
      apiFetch<CreateOutboundWebhookResult>(`/guilds/${guildId}/integrations/outbound`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationsQueryKeys.outboundWebhooks(guildId) });
    },
  });
}

export function useDeleteOutboundWebhook(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (endpointId: string) =>
      apiFetch<void>(`/guilds/${guildId}/integrations/outbound/${endpointId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationsQueryKeys.outboundWebhooks(guildId) });
    },
  });
}

export function useTestOutboundWebhook(guildId: string) {
  return useMutation({
    mutationFn: (endpointId: string) =>
      apiFetch<{ queued: boolean }>(`/guilds/${guildId}/integrations/outbound/${endpointId}/test`, {
        method: 'POST',
      }),
  });
}

export function useOutboundDeliveries(guildId: string, endpointId: string | undefined) {
  return useQuery({
    queryKey: integrationsQueryKeys.deliveries(guildId, endpointId ?? ''),
    queryFn: () =>
      apiFetch<Paginated<WebhookDeliveryDto>>(
        `/guilds/${guildId}/integrations/outbound/${endpointId}/deliveries`,
      ),
    enabled: Boolean(guildId && endpointId),
  });
}

// ---------------------------------------------------------------------------
// Twitch chat, channel points and currency are managed on the creator dashboard (ARCHITECTURE.md §19e, phase 4).
// All this dashboard keeps is a read-only "which Twitch channel is linked to this server" lookup and the server
// admin's right to unlink their own server.
// ---------------------------------------------------------------------------

export function useTwitchChatGuildLinks(guildId: string | undefined) {
  return useQuery({
    queryKey: integrationsQueryKeys.twitchChatLinks(guildId ?? ''),
    queryFn: () => apiFetch<TwitchChatGuildLinksDto>(`/guilds/${guildId}/integrations/twitch-chat`),
    enabled: Boolean(guildId),
  });
}

/** Unlinks this server from a streamer's Twitch channel (the channel itself stays with the streamer). */
export function useUnlinkTwitchChatChannel(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      apiFetch<void>(`/guilds/${guildId}/integrations/twitch-chat/channels/${channelId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationsQueryKeys.twitchChatLinks(guildId) });
    },
  });
}
