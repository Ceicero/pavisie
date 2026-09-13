'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type {
  AnalyticsDto,
  AuditLogEntryDto,
  DataRequestDto,
  GuildConfigDto,
  GuildOverviewDto,
  GuildSummary,
  Paginated,
  PluginSummary,
  RetentionPolicyDto,
} from '@pavisie/types';
import type { ChannelPickerOption, RolePickerOption } from '@pavisie/ui';
import { apiFetch, toQueryString } from './api';
import type { JsonSchema } from './json-schema';

/** Centralized React Query keys so invalidation stays consistent across hooks. */
export const queryKeys = {
  guilds: ['guilds'] as const,
  guild: (guildId: string) => ['guilds', guildId] as const,
  guildConfig: (guildId: string) => ['guilds', guildId, 'config'] as const,
  plugins: (guildId: string) => ['guilds', guildId, 'plugins'] as const,
  pluginConfig: (guildId: string, pluginId: string) =>
    ['guilds', guildId, 'plugins', pluginId, 'config'] as const,
  auditLog: (guildId: string, filters: AuditLogFilters) => ['guilds', guildId, 'audit', filters] as const,
  analytics: (guildId: string, range: AnalyticsRange) => ['guilds', guildId, 'analytics', range] as const,
  retention: (guildId: string) => ['guilds', guildId, 'retention'] as const,
  dataRequests: (guildId: string) => ['guilds', guildId, 'data-requests'] as const,
  discordChannels: (guildId: string) => ['guilds', guildId, 'discord', 'channels'] as const,
  discordRoles: (guildId: string) => ['guilds', guildId, 'discord', 'roles'] as const,
};

// ---------------------------------------------------------------------------
// Guilds
// ---------------------------------------------------------------------------

/** `GET /guilds` — every guild the signed-in user can manage, with bot-presence info. */
export function useGuilds() {
  return useQuery({
    queryKey: queryKeys.guilds,
    queryFn: () => apiFetch<GuildSummary[]>('/guilds'),
  });
}

/** `GET /guilds/:guildId` — overview stats for a guild's dashboard home page (shared shape: `@pavisie/types`'s `GuildOverviewDto`). */
export function useGuild(guildId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.guild(guildId ?? ''),
    queryFn: () => apiFetch<GuildOverviewDto>(`/guilds/${guildId}`),
    enabled: Boolean(guildId),
  });
}

// ---------------------------------------------------------------------------
// Guild config
// ---------------------------------------------------------------------------

export function useGuildConfig(guildId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.guildConfig(guildId ?? ''),
    queryFn: () => apiFetch<GuildConfigDto>(`/guilds/${guildId}/config`),
    enabled: Boolean(guildId),
  });
}

export type GuildConfigPatch = Partial<Omit<GuildConfigDto, 'guildId'>>;

export function useUpdateGuildConfig(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: GuildConfigPatch) =>
      apiFetch<GuildConfigDto>(`/guilds/${guildId}/config`, { method: 'PATCH', body: patch }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.guildConfig(guildId), data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.guild(guildId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export function usePlugins(guildId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.plugins(guildId ?? ''),
    queryFn: () => apiFetch<PluginSummary[]>(`/guilds/${guildId}/plugins`),
    enabled: Boolean(guildId),
  });
}

export function useTogglePlugin(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // apps/api's enable/disable routes return `{ ok: true }`, not a `PluginSummary` — the response is unused
    // here anyway (the cache is updated optimistically above/below), but the declared type should match reality.
    mutationFn: ({ pluginId, enabled }: { pluginId: string; enabled: boolean }) =>
      apiFetch<{ ok: boolean }>(`/guilds/${guildId}/plugins/${pluginId}/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST',
      }),
    onMutate: async ({ pluginId, enabled }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.plugins(guildId) });
      const previous = queryClient.getQueryData<PluginSummary[]>(queryKeys.plugins(guildId));
      queryClient.setQueryData<PluginSummary[] | undefined>(queryKeys.plugins(guildId), (current) =>
        current?.map((p) => (p.id === pluginId ? { ...p, enabled } : p)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.plugins(guildId), context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins(guildId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.guild(guildId) });
    },
  });
}

export interface PluginConfigResponse<T = unknown> {
  config: T;
  schema: JsonSchema;
}

export function usePluginConfig<T = unknown>(guildId: string | undefined, pluginId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.pluginConfig(guildId ?? '', pluginId ?? ''),
    queryFn: () => apiFetch<PluginConfigResponse<T>>(`/guilds/${guildId}/plugins/${pluginId}/config`),
    enabled: Boolean(guildId && pluginId),
  });
}

export function useUpdatePluginConfig<T = unknown>(guildId: string, pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<T>) =>
      apiFetch<PluginConfigResponse<T>>(`/guilds/${guildId}/plugins/${pluginId}/config`, {
        method: 'PUT',
        body: patch,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.pluginConfig(guildId, pluginId), data);
    },
  });
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditLogFilters {
  cursor?: string;
  limit?: number;
  action?: string;
  actorId?: string;
}

export function useAuditLog(guildId: string | undefined, filters: AuditLogFilters = {}) {
  return useQuery({
    queryKey: queryKeys.auditLog(guildId ?? '', filters),
    queryFn: () =>
      apiFetch<Paginated<AuditLogEntryDto>>(`/guilds/${guildId}/audit${toQueryString({ ...filters })}`),
    enabled: Boolean(guildId),
  });
}

export function auditExportCsvUrl(guildId: string): string {
  return `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/guilds/${guildId}/audit/export.csv`;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export type AnalyticsRange = '7d' | '30d' | '90d';

export function useAnalytics(guildId: string | undefined, range: AnalyticsRange = '7d') {
  return useQuery({
    queryKey: queryKeys.analytics(guildId ?? '', range),
    queryFn: () => apiFetch<AnalyticsDto>(`/guilds/${guildId}/analytics${toQueryString({ range })}`),
    enabled: Boolean(guildId),
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Privacy: retention + data requests
// ---------------------------------------------------------------------------

/** `/guilds/:guildId/privacy/retention` — matches apps/api's routes/privacy.ts (ARCHITECTURE.md §10). */
export function useRetention(guildId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.retention(guildId ?? ''),
    queryFn: () => apiFetch<RetentionPolicyDto>(`/guilds/${guildId}/privacy/retention`),
    enabled: Boolean(guildId),
  });
}

export function useUpdateRetention(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Omit<RetentionPolicyDto, 'guildId' | 'updatedAt'>>) =>
      apiFetch<RetentionPolicyDto>(`/guilds/${guildId}/privacy/retention`, { method: 'PUT', body: patch }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.retention(guildId), data);
    },
  });
}

export function useDataRequests(guildId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.dataRequests(guildId ?? ''),
    // The API returns the standard `Paginated<DataRequestDto>` envelope (ARCHITECTURE.md §10); `select`
    // unwraps `.items` so callers keep working with a plain array.
    queryFn: () => apiFetch<Paginated<DataRequestDto>>(`/guilds/${guildId}/data/requests`),
    select: (res) => res.items,
    enabled: Boolean(guildId),
    refetchInterval: (query) =>
      query.state.data?.items.some((r) => r.status === 'pending' || r.status === 'processing') ? 5000 : false,
  });
}

export function useRequestDataExport(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<DataRequestDto>(`/guilds/${guildId}/data/export`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dataRequests(guildId) });
    },
  });
}

export function useRequestDataDelete(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Body key is `confirm`, matching apps/api's routes/privacy.ts `deleteBodySchema`.
    mutationFn: (confirmationPhrase: string) =>
      apiFetch<DataRequestDto>(`/guilds/${guildId}/data/delete`, {
        method: 'POST',
        body: { confirm: confirmationPhrase },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dataRequests(guildId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Discord option pickers (channels/roles) — optional endpoints; callers should treat
// `isError` as "fall back to a plain text input" per docs/ARCHITECTURE.md §11.
// ---------------------------------------------------------------------------

function optionalQuery<T>(key: readonly unknown[], fetcher: () => Promise<T>, enabled: boolean) {
  const options: UseQueryOptions<T> = {
    queryKey: key as unknown[],
    queryFn: fetcher,
    enabled,
    retry: false,
    staleTime: 60_000,
  };
  return options;
}

export function useGuildChannels(guildId: string | undefined) {
  return useQuery(
    optionalQuery<ChannelPickerOption[]>(
      queryKeys.discordChannels(guildId ?? ''),
      () => apiFetch<ChannelPickerOption[]>(`/guilds/${guildId}/discord/channels`),
      Boolean(guildId),
    ),
  );
}

export function useGuildRoles(guildId: string | undefined) {
  return useQuery(
    optionalQuery<RolePickerOption[]>(
      queryKeys.discordRoles(guildId ?? ''),
      () => apiFetch<RolePickerOption[]>(`/guilds/${guildId}/discord/roles`),
      Boolean(guildId),
    ),
  );
}
