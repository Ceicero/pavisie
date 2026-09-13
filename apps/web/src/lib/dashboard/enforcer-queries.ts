'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EnforcerPolicyDto, EnforcerRecordDto, EnforcerSettingsDto, Paginated } from '@pavisie/types';
import { API_BASE_URL, apiFetch, toQueryString } from './api';

export const enforcerQueryKeys = {
  settings: (guildId: string) => ['guilds', guildId, 'enforcer', 'settings'] as const,
  policies: (guildId: string) => ['guilds', guildId, 'enforcer', 'policies'] as const,
  policy: (guildId: string, policyId: string) =>
    ['guilds', guildId, 'enforcer', 'policies', policyId] as const,
  queue: (guildId: string) => ['guilds', guildId, 'enforcer', 'queue'] as const,
  records: (guildId: string, filters: EnforcerRecordFilters) =>
    ['guilds', guildId, 'enforcer', 'records', filters] as const,
  record: (guildId: string, recordNumber: number) =>
    ['guilds', guildId, 'enforcer', 'records', recordNumber] as const,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function useEnforcerSettings(guildId: string | undefined) {
  return useQuery({
    queryKey: enforcerQueryKeys.settings(guildId ?? ''),
    queryFn: () => apiFetch<EnforcerSettingsDto>(`/guilds/${guildId}/enforcer/settings`),
    enabled: Boolean(guildId),
  });
}

export function useUpdateEnforcerSettings(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<EnforcerSettingsDto>) =>
      apiFetch<EnforcerSettingsDto>(`/guilds/${guildId}/enforcer/settings`, { method: 'PUT', body: patch }),
    onSuccess: (data) => {
      queryClient.setQueryData(enforcerQueryKeys.settings(guildId), data);
    },
  });
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export function useEnforcerPolicies(guildId: string | undefined) {
  return useQuery({
    queryKey: enforcerQueryKeys.policies(guildId ?? ''),
    queryFn: () => apiFetch<EnforcerPolicyDto[]>(`/guilds/${guildId}/enforcer/policies`),
    enabled: Boolean(guildId),
  });
}

export type EnforcerPolicyInput = Omit<
  EnforcerPolicyDto,
  'id' | 'guildId' | 'createdBy' | 'updatedBy' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export function useCreateEnforcerPolicy(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: EnforcerPolicyInput) =>
      apiFetch<EnforcerPolicyDto>(`/guilds/${guildId}/enforcer/policies`, { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: enforcerQueryKeys.policies(guildId) });
    },
  });
}

export function useUpdateEnforcerPolicy(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ policyId, patch }: { policyId: string; patch: Partial<EnforcerPolicyInput> }) =>
      apiFetch<EnforcerPolicyDto>(`/guilds/${guildId}/enforcer/policies/${policyId}`, {
        method: 'PUT',
        body: patch,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: enforcerQueryKeys.policies(guildId) });
    },
  });
}

export function useDeleteEnforcerPolicy(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policyId: string) =>
      apiFetch<void>(`/guilds/${guildId}/enforcer/policies/${policyId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: enforcerQueryKeys.policies(guildId) });
    },
  });
}

export interface EnforcerPolicyTestResult {
  matched: boolean;
  matches: { policyId: string; policyName: string; severity: string; matcherSummary: string }[];
}

export function useTestEnforcerPolicy(guildId: string) {
  return useMutation({
    mutationFn: ({ policyId, text }: { policyId: string; text: string }) =>
      apiFetch<EnforcerPolicyTestResult>(`/guilds/${guildId}/enforcer/policies/${policyId}/test`, {
        method: 'POST',
        body: { text },
      }),
  });
}

// ---------------------------------------------------------------------------
// Queue (pending flags)
// ---------------------------------------------------------------------------

export function useEnforcerQueue(guildId: string | undefined) {
  return useQuery({
    queryKey: enforcerQueryKeys.queue(guildId ?? ''),
    queryFn: () => apiFetch<EnforcerRecordDto[]>(`/guilds/${guildId}/enforcer/queue`),
    enabled: Boolean(guildId),
    refetchInterval: 15_000,
  });
}

export interface DecideInput {
  recordNumber: number;
  decision: 'WARN' | 'TIMEOUT' | 'MUTE' | 'UNMUTE' | 'KICK' | 'BAN' | 'DISMISS';
  reason?: string;
  durationMs?: number;
  banDeleteMessageSeconds?: number;
}

export function useDecideEnforcerRecord(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ recordNumber, ...body }: DecideInput) =>
      apiFetch<{ queued: boolean }>(`/guilds/${guildId}/enforcer/records/${recordNumber}/decide`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: enforcerQueryKeys.queue(guildId) });
      void queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'enforcer', 'records'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Ledger records (search)
// ---------------------------------------------------------------------------

export interface EnforcerRecordFilters {
  cursor?: string;
  limit?: number;
  userId?: string;
  kind?: string;
  decision?: string;
  status?: string;
  policyId?: string;
  since?: string;
}

export function useEnforcerRecords(guildId: string | undefined, filters: EnforcerRecordFilters = {}) {
  return useQuery({
    queryKey: enforcerQueryKeys.records(guildId ?? '', filters),
    queryFn: () =>
      apiFetch<Paginated<EnforcerRecordDto>>(
        `/guilds/${guildId}/enforcer/records${toQueryString({ ...filters })}`,
      ),
    enabled: Boolean(guildId),
  });
}

export function useEnforcerRecord(guildId: string | undefined, recordNumber: number | undefined) {
  return useQuery({
    queryKey: enforcerQueryKeys.record(guildId ?? '', recordNumber ?? 0),
    queryFn: () => apiFetch<EnforcerRecordDto>(`/guilds/${guildId}/enforcer/records/${recordNumber}`),
    enabled: Boolean(guildId && recordNumber),
  });
}

export function enforcerRecordsExportCsvUrl(guildId: string, filters: EnforcerRecordFilters = {}): string {
  return `${API_BASE_URL}/guilds/${guildId}/enforcer/records/export.csv${toQueryString({ ...filters })}`;
}
