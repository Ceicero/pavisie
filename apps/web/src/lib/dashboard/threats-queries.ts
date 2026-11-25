'use client';

import { useQuery } from '@tanstack/react-query';
import type { ModerationAuditEntryDto, Paginated, ThreatIncidentDto } from '@pavisie/types';
import { apiFetch, toQueryString } from './api';

export interface ThreatAuditFilters {
  cursor?: string;
  limit?: number;
  action?: string;
  actorId?: string;
}

export const threatsQueryKeys = {
  audit: (guildId: string, filters: ThreatAuditFilters) =>
    ['guilds', guildId, 'threats', 'audit', filters] as const,
  incidents: (guildId: string) => ['guilds', guildId, 'threats', 'incidents'] as const,
};

/** `GET /guilds/:guildId/threats/audit` — moderation.* audit trail, newest first. */
export function useThreatAudit(guildId: string | undefined, filters: ThreatAuditFilters = {}) {
  return useQuery({
    queryKey: threatsQueryKeys.audit(guildId ?? '', filters),
    queryFn: () =>
      apiFetch<Paginated<ModerationAuditEntryDto>>(
        `/guilds/${guildId}/threats/audit${toQueryString({ ...filters })}`,
      ),
    enabled: Boolean(guildId),
  });
}

/**
 * `GET /guilds/:guildId/threats/incidents` — live raid/threat incidents.
 * Served from the stub adapter until Claude's raid-mode API lands. Polls every
 * 15 seconds, matching the enforcer queue.
 */
export function useThreatIncidents(guildId: string | undefined) {
  return useQuery({
    queryKey: threatsQueryKeys.incidents(guildId ?? ''),
    queryFn: () => apiFetch<ThreatIncidentDto[]>(`/guilds/${guildId}/threats/incidents`),
    enabled: Boolean(guildId),
    refetchInterval: 15_000,
  });
}

/** True when an audit row can open the existing case detail drawer. */
export function canOpenCaseDrawer(entry: Pick<ModerationAuditEntryDto, 'caseNumber'>): boolean {
  return typeof entry.caseNumber === 'number' && entry.caseNumber > 0;
}
