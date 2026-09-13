'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AutomodEventDto, AutomodRuleDto, Paginated } from '@pavisie/types';
import type { AutomodRuleInput, AutomodRuleTestResult } from '@pavisie/types/automod';
import { apiFetch, toQueryString } from './api';

export const automodQueryKeys = {
  rules: (guildId: string) => ['guilds', guildId, 'automod', 'rules'] as const,
  events: (guildId: string, filters: AutomodEventFilters) =>
    ['guilds', guildId, 'automod', 'events', filters] as const,
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export function useAutomodRules(guildId: string | undefined) {
  return useQuery({
    queryKey: automodQueryKeys.rules(guildId ?? ''),
    queryFn: () => apiFetch<AutomodRuleDto[]>(`/guilds/${guildId}/automod/rules`),
    enabled: Boolean(guildId),
  });
}

export function useCreateAutomodRule(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AutomodRuleInput) =>
      apiFetch<AutomodRuleDto>(`/guilds/${guildId}/automod/rules`, { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: automodQueryKeys.rules(guildId) });
    },
  });
}

export function useUpdateAutomodRule(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, patch }: { ruleId: string; patch: AutomodRuleInput }) =>
      apiFetch<AutomodRuleDto>(`/guilds/${guildId}/automod/rules/${ruleId}`, { method: 'PUT', body: patch }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: automodQueryKeys.rules(guildId) });
    },
  });
}

export function useDeleteAutomodRule(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) =>
      apiFetch<void>(`/guilds/${guildId}/automod/rules/${ruleId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: automodQueryKeys.rules(guildId) });
    },
  });
}

export function useSetRuleDryRun(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, dryRun }: { ruleId: string; dryRun: boolean }) =>
      apiFetch<AutomodRuleDto>(`/guilds/${guildId}/automod/rules/${ruleId}/dry-run`, {
        method: 'POST',
        body: { dryRun },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: automodQueryKeys.rules(guildId) });
    },
  });
}

/** Guild-wide dry-run switch (separate from each rule's own `dryRun`, and from the `automod` plugin config's `dryRun` — this endpoint flips every rule's `dryRun` at once). */
export function useSetGuildWideDryRun(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dryRun: boolean) =>
      apiFetch<{ ok: boolean; rulesAffected: number }>(`/guilds/${guildId}/automod/dry-run`, {
        method: 'POST',
        body: { dryRun },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: automodQueryKeys.rules(guildId) });
    },
  });
}

export function useTestAutomodRule(guildId: string) {
  return useMutation({
    mutationFn: ({ ruleId, text }: { ruleId: string; text: string }) =>
      apiFetch<AutomodRuleTestResult>(`/guilds/${guildId}/automod/rules/${ruleId}/test`, {
        method: 'POST',
        body: { text },
      }),
  });
}

// ---------------------------------------------------------------------------
// Events / review queue
// ---------------------------------------------------------------------------

export interface AutomodEventFilters {
  reviewStatus?: 'NONE' | 'PENDING' | 'CONFIRMED' | 'FALSE_POSITIVE';
  cursor?: string;
  limit?: number;
}

export function useAutomodEvents(guildId: string | undefined, filters: AutomodEventFilters = {}) {
  return useQuery({
    queryKey: automodQueryKeys.events(guildId ?? '', filters),
    queryFn: () =>
      apiFetch<Paginated<AutomodEventDto>>(
        `/guilds/${guildId}/automod/events${toQueryString({ ...filters })}`,
      ),
    enabled: Boolean(guildId),
  });
}

export function useReviewAutomodEvent(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      eventId,
      reviewStatus,
    }: {
      eventId: string;
      reviewStatus: 'CONFIRMED' | 'FALSE_POSITIVE';
    }) =>
      apiFetch<AutomodEventDto>(`/guilds/${guildId}/automod/events/${eventId}/review`, {
        method: 'PATCH',
        body: { reviewStatus },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'automod', 'events'] });
    },
  });
}
