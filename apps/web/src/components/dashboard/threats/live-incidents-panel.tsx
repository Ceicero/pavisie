'use client';

import type { ThreatIncidentDto, ThreatIncidentKind, ThreatIncidentStatus } from '@pavisie/types';
import { ShieldAlert } from 'lucide-react';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from '@pavisie/ui';
import { formatDateTime } from '@/lib/dashboard/format';
import { useThreatIncidents } from '@/lib/dashboard/threats-queries';
import { ErrorState } from '../error-state';

/** Honest empty-state copy: this panel is not a working detector yet. */
export const NO_ACTIVE_THREATS_MESSAGE = 'No active threats. Raid detection is coming soon.';

export const THREAT_KIND_LABEL: Record<ThreatIncidentKind, string> = {
  raid: 'Raid',
  message_burst: 'Message burst',
  lockdown: 'Lockdown',
};

export const THREAT_STATUS_BADGE: Record<ThreatIncidentStatus, 'destructive' | 'secondary'> = {
  active: 'destructive',
  ended: 'secondary',
};

/** Kind-specific fields shown on an incident card. Exported so tests can cover fixtures. */
export function threatIncidentDetails(incident: ThreatIncidentDto): { label: string; value: string }[] {
  const details: { label: string; value: string }[] = [];
  if (incident.kind === 'raid' && incident.joinsFlagged !== undefined) {
    details.push({ label: 'Joins flagged', value: String(incident.joinsFlagged) });
  }
  if (incident.kind === 'message_burst') {
    if (incident.matches !== undefined) details.push({ label: 'Matches', value: `+${incident.matches}` });
    if (incident.members !== undefined) details.push({ label: 'Members', value: String(incident.members) });
    if (incident.channelId) details.push({ label: 'Channel', value: incident.channelId });
  }
  if (incident.kind === 'lockdown' && incident.lockdownAction) {
    details.push({ label: 'Action', value: incident.lockdownAction });
  }
  return details;
}

export function IncidentCard({ incident }: { incident: ThreatIncidentDto }) {
  const details = threatIncidentDetails(incident);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{incident.ruleName}</CardTitle>
          <Badge variant="outline">{THREAT_KIND_LABEL[incident.kind]}</Badge>
          <Badge variant={THREAT_STATUS_BADGE[incident.status]} className="capitalize">
            {incident.status}
          </Badge>
          {incident.dryRun ? <Badge variant="secondary">Dry run</Badge> : null}
        </div>
        <CardDescription>
          Started {formatDateTime(incident.startedAt)}
          {incident.status === 'ended' && incident.endedAt
            ? ` · Ended ${formatDateTime(incident.endedAt)}`
            : ` · Last activity ${formatDateTime(incident.lastActivityAt)}`}
        </CardDescription>
      </CardHeader>
      {details.length > 0 ? (
        <CardContent>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            {details.map((item) => (
              <div key={item.label}>
                <dt className="text-xs text-muted-foreground">{item.label}</dt>
                <dd className="font-mono text-xs">{item.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      ) : null}
    </Card>
  );
}

export function LiveIncidentsPanel({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useThreatIncidents(guildId);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Threats</h2>
        <p className="text-sm text-muted-foreground">Raids, message bursts, and lockdowns for this server.</p>
      </div>

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => refetch()} title="Could not load threats" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={<ShieldAlert />} title={NO_ACTIVE_THREATS_MESSAGE} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} />
          ))}
        </div>
      )}
    </section>
  );
}
