'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LogEventDto, Paginated } from '@pavisie/types';
// Not (yet) re-exported from `@pavisie/types`'s barrel — see `packages/types/src/logging.ts`'s header comment.
import type {
  LoggingConfigDto,
  RedactionTestRequestDto,
  RedactionTestResponseDto,
} from '@pavisie/types/logging';
import { apiFetch, toQueryString } from './api';

/** Own query-key namespace per this plugin's ownership boundary (do not add these to the shared `lib/queries.ts`). */
export const loggingQueryKeys = {
  settings: (guildId: string) => ['guilds', guildId, 'logging', 'settings'] as const,
  logs: (guildId: string, filters: LogSearchFilters) =>
    ['guilds', guildId, 'logging', 'logs', filters] as const,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function useLoggingSettings(guildId: string | undefined) {
  return useQuery({
    queryKey: loggingQueryKeys.settings(guildId ?? ''),
    queryFn: () => apiFetch<LoggingConfigDto>(`/guilds/${guildId}/logging/settings`),
    enabled: Boolean(guildId),
  });
}

export function useUpdateLoggingSettings(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<LoggingConfigDto>) =>
      apiFetch<LoggingConfigDto>(`/guilds/${guildId}/logging/settings`, { method: 'PUT', body: patch }),
    onSuccess: (data) => {
      queryClient.setQueryData(loggingQueryKeys.settings(guildId), data);
    },
  });
}

// ---------------------------------------------------------------------------
// Log search
// ---------------------------------------------------------------------------

export interface LogSearchFilters {
  cursor?: string;
  limit?: number;
  kind?: string;
  actorId?: string;
  targetId?: string;
  since?: string;
  until?: string;
  q?: string;
}

export function useLogSearch(guildId: string | undefined, filters: LogSearchFilters = {}) {
  return useQuery({
    queryKey: loggingQueryKeys.logs(guildId ?? '', filters),
    queryFn: () =>
      apiFetch<Paginated<LogEventDto>>(`/guilds/${guildId}/logging/logs${toQueryString({ ...filters })}`),
    enabled: Boolean(guildId),
  });
}

/** Builds the CSV export URL for the current filters — used as a plain `<a href>` (server sets `Content-Disposition`), matching `auditExportCsvUrl` in the shared `lib/queries.ts`. */
export function logsExportCsvUrl(guildId: string, filters: LogSearchFilters = {}): string {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  return `${base}/guilds/${guildId}/logging/logs/export.csv${toQueryString({ ...filters })}`;
}

// ---------------------------------------------------------------------------
// Redaction test
// ---------------------------------------------------------------------------

export function useRedactionTest(guildId: string) {
  return useMutation({
    mutationFn: (body: RedactionTestRequestDto) =>
      apiFetch<RedactionTestResponseDto>(`/guilds/${guildId}/logging/redaction/test`, {
        method: 'POST',
        body,
      }),
  });
}
