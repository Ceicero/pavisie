'use client';

import * as React from 'react';
import type { EnforcerRecordDto } from '@pavisie/types';
import { Badge, Button, PageHeader } from '@pavisie/ui';
import { useEnforcerQueue, type DecideInput } from '@/lib/dashboard/enforcer-queries';
import { DataTable, type DataTableColumn } from '../data-table';
import { formatDateTime } from '@/lib/dashboard/format';
import { DecideDialog } from './decide-dialog';

const DECISIONS: {
  value: DecideInput['decision'];
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
}[] = [
  { value: 'WARN', label: 'Warn', variant: 'secondary' },
  { value: 'TIMEOUT', label: 'Timeout', variant: 'secondary' },
  { value: 'MUTE', label: 'Mute', variant: 'secondary' },
  { value: 'KICK', label: 'Kick', variant: 'destructive' },
  { value: 'BAN', label: 'Ban', variant: 'destructive' },
  { value: 'DISMISS', label: 'Dismiss', variant: 'outline' },
];

export interface QueueTabProps {
  guildId: string;
}

export function QueueTab({ guildId }: QueueTabProps) {
  const { data: queue, isLoading, error, refetch } = useEnforcerQueue(guildId);
  const [target, setTarget] = React.useState<{
    record: EnforcerRecordDto;
    decision: DecideInput['decision'];
  } | null>(null);

  const columns: DataTableColumn<EnforcerRecordDto>[] = [
    {
      key: 'record',
      header: 'Record',
      render: (r) => <span className="font-mono text-xs">#E-{r.recordNumber}</span>,
    },
    { key: 'user', header: 'User', render: (r) => <span className="font-mono text-xs">{r.userId}</span> },
    { key: 'policy', header: 'Policy', render: (r) => r.policyName ?? '_manual_' },
    {
      key: 'matched',
      header: 'Matched',
      render: (r) => (
        <span className="max-w-xs truncate text-xs text-muted-foreground">{r.matcherSummary ?? '—'}</span>
      ),
    },
    {
      key: 'excerpt',
      header: 'Excerpt',
      render: (r) => (
        <span className="max-w-xs truncate text-xs">
          {r.excerpt ?? (r.messageJumpUrl ? '(context only, no excerpt stored)' : '—')}
        </span>
      ),
    },
    { key: 'when', header: 'When', render: (r) => formatDateTime(r.createdAt) },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.messageJumpUrl ? (
            <Button variant="outline" size="sm" asChild>
              <a href={r.messageJumpUrl} target="_blank" rel="noreferrer">
                Jump
              </a>
            </Button>
          ) : null}
          {DECISIONS.map((d) => (
            <Button
              key={d.value}
              variant={d.variant}
              size="sm"
              onClick={() => setTarget({ record: r, decision: d.value })}
            >
              {d.label}
            </Button>
          ))}
        </div>
      ),
      className: 'min-w-[420px]',
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Flag queue"
        description="Pending flags awaiting a moderator decision. Refreshes automatically."
        actions={
          <Badge variant={queue && queue.length > 0 ? 'warning' : 'secondary'}>
            {queue?.length ?? 0} pending
          </Badge>
        }
      />

      <DataTable
        columns={columns}
        rows={queue}
        rowKey={(r) => r.id}
        loading={isLoading}
        error={error}
        onRetry={() => refetch()}
        emptyTitle="Nothing pending"
        emptyDescription="New flags — automatic or manual — will show up here."
      />

      <DecideDialog
        guildId={guildId}
        record={target?.record ?? null}
        decision={target?.decision ?? null}
        onOpenChange={(open) => !open && setTarget(null)}
      />
    </div>
  );
}
