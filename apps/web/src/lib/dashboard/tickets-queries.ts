'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated } from '@pavisie/types';
import type {
  TicketDetailDto,
  TicketIntakeFieldDto,
  TicketPanelDto,
  TicketQueueItemDto,
  TicketsSettingsDto,
} from '@pavisie/types/tickets';
import { apiFetch, toQueryString } from './api';

export const ticketsQueryKeys = {
  settings: (guildId: string) => ['guilds', guildId, 'tickets', 'settings'] as const,
  panels: (guildId: string) => ['guilds', guildId, 'tickets', 'panels'] as const,
  queue: (guildId: string, filters: TicketQueueFilters) =>
    ['guilds', guildId, 'tickets', 'queue', filters] as const,
  ticket: (guildId: string, ticketId: string) => ['guilds', guildId, 'tickets', ticketId] as const,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function useTicketSettings(guildId: string | undefined) {
  return useQuery({
    queryKey: ticketsQueryKeys.settings(guildId ?? ''),
    queryFn: () => apiFetch<TicketsSettingsDto>(`/guilds/${guildId}/tickets/settings`),
    enabled: Boolean(guildId),
  });
}

export function useUpdateTicketSettings(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<TicketsSettingsDto>) =>
      apiFetch<TicketsSettingsDto>(`/guilds/${guildId}/tickets/settings`, { method: 'PUT', body: patch }),
    onSuccess: (data) => {
      queryClient.setQueryData(ticketsQueryKeys.settings(guildId), data);
    },
  });
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export function useTicketPanels(guildId: string | undefined) {
  return useQuery({
    queryKey: ticketsQueryKeys.panels(guildId ?? ''),
    queryFn: () => apiFetch<TicketPanelDto[]>(`/guilds/${guildId}/tickets/panels`),
    enabled: Boolean(guildId),
  });
}

export type CreateTicketPanelInput = {
  channelId: string;
  title: string;
  description: string;
  buttonLabel: string;
  categoryId?: string | null;
  supportRoleIds: string[];
  mode: 'CHANNEL' | 'THREAD';
  slaMinutes?: number | null;
  intakeForm?: TicketIntakeFieldDto[] | null;
};

export function useCreateTicketPanel(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTicketPanelInput) =>
      apiFetch<TicketPanelDto>(`/guilds/${guildId}/tickets/panels`, { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ticketsQueryKeys.panels(guildId) });
    },
  });
}

export function useUpdateTicketPanel(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ panelId, patch }: { panelId: string; patch: Partial<CreateTicketPanelInput> }) =>
      apiFetch<TicketPanelDto>(`/guilds/${guildId}/tickets/panels/${panelId}`, {
        method: 'PUT',
        body: patch,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ticketsQueryKeys.panels(guildId) });
    },
  });
}

export function useDeleteTicketPanel(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (panelId: string) =>
      apiFetch<null>(`/guilds/${guildId}/tickets/panels/${panelId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ticketsQueryKeys.panels(guildId) });
    },
  });
}

export function usePostTicketPanel(guildId: string) {
  return useMutation({
    mutationFn: (panelId: string) =>
      apiFetch<{ ok: true; queued: true }>(`/guilds/${guildId}/tickets/panels/${panelId}/post`, {
        method: 'POST',
      }),
  });
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface TicketQueueFilters {
  status?: 'OPEN' | 'CLOSED' | 'ARCHIVED';
  assigneeId?: string;
  tag?: string;
  cursor?: string;
}

export function useTicketQueue(guildId: string | undefined, filters: TicketQueueFilters = {}) {
  return useQuery({
    queryKey: ticketsQueryKeys.queue(guildId ?? '', filters),
    queryFn: () =>
      apiFetch<Paginated<TicketQueueItemDto>>(
        `/guilds/${guildId}/tickets/queue${toQueryString({ ...filters })}`,
      ),
    enabled: Boolean(guildId),
  });
}

export function useTicket(guildId: string | undefined, ticketId: string | undefined) {
  return useQuery({
    queryKey: ticketsQueryKeys.ticket(guildId ?? '', ticketId ?? ''),
    queryFn: () => apiFetch<TicketDetailDto>(`/guilds/${guildId}/tickets/${ticketId}`),
    enabled: Boolean(guildId && ticketId),
  });
}

export function useCloseTicket(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, reason }: { ticketId: string; reason?: string }) =>
      apiFetch<{ ok: true; queued: true }>(`/guilds/${guildId}/tickets/${ticketId}/close`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: (_data, { ticketId }) => {
      void queryClient.invalidateQueries({ queryKey: ticketsQueryKeys.ticket(guildId, ticketId) });
      void queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'tickets', 'queue'] });
    },
  });
}

export function useAssignTicket(guildId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, assigneeId }: { ticketId: string; assigneeId: string | null }) =>
      apiFetch<TicketQueueItemDto>(`/guilds/${guildId}/tickets/${ticketId}/assign`, {
        method: 'POST',
        body: { assigneeId },
      }),
    onSuccess: (_data, { ticketId }) => {
      void queryClient.invalidateQueries({ queryKey: ticketsQueryKeys.ticket(guildId, ticketId) });
      void queryClient.invalidateQueries({ queryKey: ['guilds', guildId, 'tickets', 'queue'] });
    },
  });
}

/** Builds the download URL for a ticket's transcript (HTML by default). Browser navigates directly; the API sets `Content-Disposition`. */
export function ticketTranscriptUrl(
  guildId: string,
  ticketId: string,
  format: 'html' | 'json' = 'html',
): string {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  return `${base}/guilds/${guildId}/tickets/${ticketId}/transcript${toQueryString({ format })}`;
}
