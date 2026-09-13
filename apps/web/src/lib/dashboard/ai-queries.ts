'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiSettingsDto,
  AiSettingsPatchDto,
  AiTestResultDto,
  AiUsageSummaryDto,
} from '@pavisie/types/ai';
import { apiFetch, toQueryString } from './api';

/** Query keys for the `ai` plugin's dashboard page — kept separate from the shared `queryKeys` in `queries.ts` (not editing that shared file per ownership). */
export const aiQueryKeys = {
  settings: (guildId: string) => ['guilds', guildId, 'ai', 'settings'] as const,
  usage: (guildId: string, days: number) => ['guilds', guildId, 'ai', 'usage', days] as const,
};

/** `GET /guilds/:guildId/ai/settings`. */
export function useAiSettings(guildId: string | undefined) {
  return useQuery({
    queryKey: aiQueryKeys.settings(guildId ?? ''),
    queryFn: () => apiFetch<AiSettingsDto>(`/guilds/${guildId}/ai/settings`),
    enabled: Boolean(guildId),
  });
}

/** `PUT /guilds/:guildId/ai/settings`. */
export function useUpdateAiSettings(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: AiSettingsPatchDto) =>
      apiFetch<AiSettingsDto>(`/guilds/${guildId}/ai/settings`, { method: 'PUT', body: patch }),
    onSuccess: (data) => {
      queryClient.setQueryData(aiQueryKeys.settings(guildId), data);
    },
  });
}

/** `GET /guilds/:guildId/ai/usage?days=` — token usage summary for the usage chart + top-commands table. */
export function useAiUsage(guildId: string | undefined, days = 30) {
  return useQuery({
    queryKey: aiQueryKeys.usage(guildId ?? '', days),
    queryFn: () => apiFetch<AiUsageSummaryDto>(`/guilds/${guildId}/ai/usage${toQueryString({ days })}`),
    enabled: Boolean(guildId),
  });
}

/** `POST /guilds/:guildId/ai/test` — queues a live round-trip against the configured provider via a bot-action. */
export function useTestAiConnection(guildId: string) {
  return useMutation({
    mutationFn: () => apiFetch<AiTestResultDto>(`/guilds/${guildId}/ai/test`, { method: 'POST' }),
  });
}
