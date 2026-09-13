'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated } from '@pavisie/types';
import type {
  ConnectOAuthResponseDto,
  CreateAlertConnectionInput,
  CreateOutboundEndpointInput,
  CreateTwitchChatCommandInput,
  CreateTwitchChatRewardInput,
  CreateTwitchChatTimerInput,
  IntegrationConnectionDetailDto,
  IntegrationLiveStatusDto,
  IntegrationProviderInfoDto,
  TwitchChatChannelDto,
  TwitchChatCommandDto,
  TwitchChatRewardDto,
  TwitchChatStatusDto,
  TwitchChatTimerDto,
  TwitchOverlayInfoDto,
  UpdateTwitchChatChannelInput,
  UpdateTwitchChatCommandInput,
  UpdateTwitchChatRewardInput,
  UpdateTwitchChatTimerInput,
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
  twitchChatStatus: (guildId: string) => ['guilds', guildId, 'integrations', 'twitch-chat', 'status'] as const,
  twitchChatCommands: (guildId: string, channelId: string) =>
    ['guilds', guildId, 'integrations', 'twitch-chat', 'channels', channelId, 'commands'] as const,
  twitchChatTimers: (guildId: string, channelId: string) =>
    ['guilds', guildId, 'integrations', 'twitch-chat', 'channels', channelId, 'timers'] as const,
  twitchChatRewards: (guildId: string, channelId: string) =>
    ['guilds', guildId, 'integrations', 'twitch-chat', 'channels', channelId, 'rewards'] as const,
  twitchChatOverlay: (guildId: string, channelId: string) =>
    ['guilds', guildId, 'integrations', 'twitch-chat', 'channels', channelId, 'overlay'] as const,
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
// Twitch chat bot (Pavisie joining a streamer's Twitch chat) — lives inside this same `integrations`
// plugin rather than as its own tab-worth of unrelated infra. See @pavisie/types/integrations for the DTOs.
// ---------------------------------------------------------------------------

export function useTwitchChatStatus(guildId: string | undefined) {
  return useQuery({
    queryKey: integrationsQueryKeys.twitchChatStatus(guildId ?? ''),
    queryFn: () => apiFetch<TwitchChatStatusDto>(`/guilds/${guildId}/integrations/twitch-chat`),
    enabled: Boolean(guildId),
  });
}

export function useConnectTwitchChat(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ConnectOAuthResponseDto>(`/guilds/${guildId}/integrations/twitch-chat/connect`, {
        method: 'POST',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationsQueryKeys.twitchChatStatus(guildId) });
    },
  });
}

export function useUpdateTwitchChatChannel(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, patch }: { channelId: string; patch: UpdateTwitchChatChannelInput }) =>
      apiFetch<TwitchChatChannelDto>(`/guilds/${guildId}/integrations/twitch-chat/channels/${channelId}`, {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationsQueryKeys.twitchChatStatus(guildId) });
    },
  });
}

export function useDeleteTwitchChatChannel(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channelId: string) =>
      apiFetch<void>(`/guilds/${guildId}/integrations/twitch-chat/channels/${channelId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationsQueryKeys.twitchChatStatus(guildId) });
    },
  });
}

export function useTwitchChatCommands(guildId: string | undefined, channelId: string | undefined) {
  return useQuery({
    queryKey: integrationsQueryKeys.twitchChatCommands(guildId ?? '', channelId ?? ''),
    queryFn: () =>
      apiFetch<TwitchChatCommandDto[]>(
        `/guilds/${guildId}/integrations/twitch-chat/channels/${channelId}/commands`,
      ),
    enabled: Boolean(guildId && channelId),
  });
}

export function useCreateTwitchChatCommand(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, input }: { channelId: string; input: CreateTwitchChatCommandInput }) =>
      apiFetch<TwitchChatCommandDto>(
        `/guilds/${guildId}/integrations/twitch-chat/channels/${channelId}/commands`,
        { method: 'POST', body: input },
      ),
    onSuccess: (_data, { channelId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationsQueryKeys.twitchChatCommands(guildId, channelId),
      });
    },
  });
}

export function useUpdateTwitchChatCommand(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      commandId,
      patch,
    }: {
      commandId: string;
      /** Not sent to the API — used only to invalidate the right channel's commands list. */
      channelId: string;
      patch: UpdateTwitchChatCommandInput;
    }) =>
      apiFetch<TwitchChatCommandDto>(`/guilds/${guildId}/integrations/twitch-chat/commands/${commandId}`, {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: (_data, { channelId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationsQueryKeys.twitchChatCommands(guildId, channelId),
      });
    },
  });
}

export function useDeleteTwitchChatCommand(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commandId }: { commandId: string; channelId: string }) =>
      apiFetch<void>(`/guilds/${guildId}/integrations/twitch-chat/commands/${commandId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, { channelId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationsQueryKeys.twitchChatCommands(guildId, channelId),
      });
    },
  });
}

export function useTwitchChatTimers(guildId: string | undefined, channelId: string | undefined) {
  return useQuery({
    queryKey: integrationsQueryKeys.twitchChatTimers(guildId ?? '', channelId ?? ''),
    queryFn: () =>
      apiFetch<TwitchChatTimerDto[]>(
        `/guilds/${guildId}/integrations/twitch-chat/channels/${channelId}/timers`,
      ),
    enabled: Boolean(guildId && channelId),
  });
}

export function useCreateTwitchChatTimer(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, input }: { channelId: string; input: CreateTwitchChatTimerInput }) =>
      apiFetch<TwitchChatTimerDto>(
        `/guilds/${guildId}/integrations/twitch-chat/channels/${channelId}/timers`,
        { method: 'POST', body: input },
      ),
    onSuccess: (_data, { channelId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationsQueryKeys.twitchChatTimers(guildId, channelId),
      });
    },
  });
}

export function useUpdateTwitchChatTimer(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      timerId,
      patch,
    }: {
      timerId: string;
      /** Not sent to the API — used only to invalidate the right channel's timers list. */
      channelId: string;
      patch: UpdateTwitchChatTimerInput;
    }) =>
      apiFetch<TwitchChatTimerDto>(`/guilds/${guildId}/integrations/twitch-chat/timers/${timerId}`, {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: (_data, { channelId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationsQueryKeys.twitchChatTimers(guildId, channelId),
      });
    },
  });
}

export function useDeleteTwitchChatTimer(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ timerId }: { timerId: string; channelId: string }) =>
      apiFetch<void>(`/guilds/${guildId}/integrations/twitch-chat/timers/${timerId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, { channelId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationsQueryKeys.twitchChatTimers(guildId, channelId),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Twitch chat channel-point rewards
// ---------------------------------------------------------------------------

export function useTwitchChatRewards(guildId: string | undefined, channelId: string | undefined) {
  return useQuery({
    queryKey: integrationsQueryKeys.twitchChatRewards(guildId ?? '', channelId ?? ''),
    queryFn: () =>
      apiFetch<TwitchChatRewardDto[]>(
        `/guilds/${guildId}/integrations/twitch-chat/channels/${channelId}/rewards`,
      ),
    enabled: Boolean(guildId && channelId),
  });
}

export function useCreateTwitchChatReward(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, input }: { channelId: string; input: CreateTwitchChatRewardInput }) =>
      apiFetch<TwitchChatRewardDto>(
        `/guilds/${guildId}/integrations/twitch-chat/channels/${channelId}/rewards`,
        { method: 'POST', body: input },
      ),
    onSuccess: (_data, { channelId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationsQueryKeys.twitchChatRewards(guildId, channelId),
      });
    },
  });
}

export function useUpdateTwitchChatReward(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      rewardId,
      patch,
    }: {
      rewardId: string;
      /** Not sent to the API — used only to invalidate the right channel's rewards list. */
      channelId: string;
      patch: UpdateTwitchChatRewardInput;
    }) =>
      apiFetch<TwitchChatRewardDto>(`/guilds/${guildId}/integrations/twitch-chat/rewards/${rewardId}`, {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: (_data, { channelId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationsQueryKeys.twitchChatRewards(guildId, channelId),
      });
    },
  });
}

export function useDeleteTwitchChatReward(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rewardId }: { rewardId: string; channelId: string }) =>
      apiFetch<void>(`/guilds/${guildId}/integrations/twitch-chat/rewards/${rewardId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, { channelId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationsQueryKeys.twitchChatRewards(guildId, channelId),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Twitch chat overlay (rewards alerts)
// ---------------------------------------------------------------------------

export function useTwitchChatOverlay(guildId: string | undefined, channelId: string | undefined) {
  return useQuery({
    queryKey: integrationsQueryKeys.twitchChatOverlay(guildId ?? '', channelId ?? ''),
    queryFn: () =>
      apiFetch<TwitchOverlayInfoDto>(
        `/guilds/${guildId}/integrations/twitch-chat/channels/${channelId}/overlay`,
      ),
    enabled: Boolean(guildId && channelId),
  });
}

export function useRegenerateTwitchChatOverlay(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId }: { channelId: string }) =>
      apiFetch<TwitchOverlayInfoDto>(
        `/guilds/${guildId}/integrations/twitch-chat/channels/${channelId}/overlay/regenerate`,
        { method: 'POST' },
      ),
    onSuccess: (_data, { channelId }) => {
      void queryClient.invalidateQueries({
        queryKey: integrationsQueryKeys.twitchChatOverlay(guildId, channelId),
      });
    },
  });
}
