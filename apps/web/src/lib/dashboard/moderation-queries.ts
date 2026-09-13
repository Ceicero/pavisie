'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModerationCaseDto, ModerationWarningDto, Paginated } from '@pavisie/types';
import type {
  ModerationAppealDto,
  ModerationNoteDto,
  ModerationSettingsDto,
} from '@pavisie/types/moderation';
import { apiFetch, toQueryString } from './api';

export const moderationQueryKeys = {
  cases: (guildId: string, filters: CasesFilters) =>
    ['guilds', guildId, 'moderation', 'cases', filters] as const,
  case: (guildId: string, caseNumber: number) =>
    ['guilds', guildId, 'moderation', 'cases', caseNumber] as const,
  warnings: (guildId: string, userId?: string) =>
    ['guilds', guildId, 'moderation', 'warnings', userId ?? null] as const,
  notes: (guildId: string, userId?: string) =>
    ['guilds', guildId, 'moderation', 'notes', userId ?? null] as const,
  appeals: (guildId: string, status?: string) =>
    ['guilds', guildId, 'moderation', 'appeals', status ?? null] as const,
  settings: (guildId: string) => ['guilds', guildId, 'moderation', 'settings'] as const,
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface CasesFilters {
  cursor?: string;
  limit?: number;
  type?: string;
  targetId?: string;
  moderatorId?: string;
}

export function useModerationCases(guildId: string | undefined, filters: CasesFilters = {}) {
  return useQuery({
    queryKey: moderationQueryKeys.cases(guildId ?? '', filters),
    queryFn: () =>
      apiFetch<Paginated<ModerationCaseDto>>(
        `/guilds/${guildId}/moderation/cases${toQueryString({ ...filters })}`,
      ),
    enabled: Boolean(guildId),
  });
}

export function useModerationCase(guildId: string | undefined, caseNumber: number | undefined) {
  return useQuery({
    queryKey: moderationQueryKeys.case(guildId ?? '', caseNumber ?? 0),
    queryFn: () => apiFetch<ModerationCaseDto>(`/guilds/${guildId}/moderation/cases/${caseNumber}`),
    enabled: Boolean(guildId && caseNumber),
  });
}

export function useUpdateCaseReason(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ caseNumber, reason }: { caseNumber: number; reason: string }) =>
      apiFetch<ModerationCaseDto>(`/guilds/${guildId}/moderation/cases/${caseNumber}`, {
        method: 'PATCH',
        body: { reason },
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(moderationQueryKeys.case(guildId, data.caseNumber), data);
      void queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'moderation', 'cases'] });
    },
  });
}

export function moderationCasesExportCsvUrl(guildId: string): string {
  return `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/guilds/${guildId}/moderation/cases/export.csv`;
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

export function useModerationWarnings(guildId: string | undefined, userId?: string) {
  return useQuery({
    queryKey: moderationQueryKeys.warnings(guildId ?? '', userId),
    queryFn: () =>
      apiFetch<Paginated<ModerationWarningDto>>(
        `/guilds/${guildId}/moderation/warnings${toQueryString({ userId, limit: 100 })}`,
      ),
    enabled: Boolean(guildId),
  });
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export function useModerationNotes(guildId: string | undefined, userId?: string) {
  return useQuery({
    queryKey: moderationQueryKeys.notes(guildId ?? '', userId),
    queryFn: () =>
      apiFetch<Paginated<ModerationNoteDto>>(
        `/guilds/${guildId}/moderation/notes${toQueryString({ userId, limit: 100 })}`,
      ),
    enabled: Boolean(guildId && userId),
  });
}

export function useCreateModerationNote(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; content: string }) =>
      apiFetch<ModerationNoteDto>(`/guilds/${guildId}/moderation/notes`, { method: 'POST', body: input }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: moderationQueryKeys.notes(guildId, variables.userId) });
    },
  });
}

export function useDeleteModerationNote(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (noteId: string) =>
      apiFetch<void>(`/guilds/${guildId}/moderation/notes/${noteId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'moderation', 'notes'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------------------

export function useModerationAppeals(guildId: string | undefined, status?: string) {
  return useQuery({
    queryKey: moderationQueryKeys.appeals(guildId ?? '', status),
    queryFn: () =>
      apiFetch<Paginated<ModerationAppealDto>>(
        `/guilds/${guildId}/moderation/appeals${toQueryString({ status, limit: 50 })}`,
      ),
    enabled: Boolean(guildId),
  });
}

export function useDecideAppeal(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      appealId,
      accept,
      decisionNote,
    }: {
      appealId: string;
      accept: boolean;
      decisionNote?: string;
    }) =>
      apiFetch<ModerationAppealDto>(`/guilds/${guildId}/moderation/appeals/${appealId}/decide`, {
        method: 'POST',
        body: { accept, decisionNote },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'moderation', 'appeals'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function useModerationSettings(guildId: string | undefined) {
  return useQuery({
    queryKey: moderationQueryKeys.settings(guildId ?? ''),
    queryFn: () => apiFetch<ModerationSettingsDto>(`/guilds/${guildId}/moderation/settings`),
    enabled: Boolean(guildId),
  });
}

export function useUpdateModerationSettings(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<ModerationSettingsDto>) =>
      apiFetch<ModerationSettingsDto>(`/guilds/${guildId}/moderation/settings`, {
        method: 'PUT',
        body: patch,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(moderationQueryKeys.settings(guildId), data);
    },
  });
}
