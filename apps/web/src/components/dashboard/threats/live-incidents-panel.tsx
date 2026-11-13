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

const KIND_LABEL: Record<ThreatIncidentKind, string> = {
  raid: 'Raid',
  message_burst: 'Message burst',
  lockdown: 'Lockdown',
};

const STATUS_BADGE: Record<ThreatIncidentStatus, 'destructive' | 'secondary'> = {
  active: 'destructive',
  ended: 'secondary',
};

function IncidentCard({ incident }: { incident: ThreatIncidentDto }) {
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{incident.ruleName}</CardTitle>
          <Badge variant="outline">{KIND_LABEL[incident.kind]}</Badge>
          <Badge variant={STATUS_BADGE[incident.status]} className="capitalize">
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
        <h2 className="text-lg font-semibold">Live threats</h2>
        <p className="text-sm text-muted-foreground">
          Active and recently ended raids, message bursts, and lockdowns. Updates every 15 seconds.
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => refetch()} title="Could not load live threats" />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<ShieldAlert />}
          title="No live raid or threat incidents"
          description="Active raids and staff-alert bursts will show up here."
        />
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
