'use client';

import { useParams } from 'next/navigation';
import { PageHeader } from '@pavisie/ui';
import { AuditTrailPanel } from '@/components/dashboard/threats/audit-trail-panel';
import { LiveIncidentsPanel } from '@/components/dashboard/threats/live-incidents-panel';

export default function ThreatOverviewPage() {
  const { guildId } = useParams<{ guildId: string }>();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Threat overview"
        description="Live raid and threat incidents, plus a read-only trail of every moderation action in this server."
      />
      <LiveIncidentsPanel guildId={guildId} />
      <AuditTrailPanel guildId={guildId} />
    </div>
  );
}
