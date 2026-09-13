'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { Download } from 'lucide-react';
import {
  Badge,
  Button,
  Input,
  PageHeader,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@pavisie/ui';
import { auditExportCsvUrl, useAuditLog, type AuditLogFilters } from '@/lib/dashboard/queries';
import { DataTable, type DataTableColumn } from '@/components/dashboard/data-table';
import { formatDateTime, humanizeAction } from '@/lib/dashboard/format';
import type { AuditLogEntryDto } from '@pavisie/types';

const SOURCE_BADGE: Record<AuditLogEntryDto['source'], 'default' | 'secondary' | 'outline'> = {
  bot: 'outline',
  dashboard: 'default',
  system: 'secondary',
};

export default function AuditLogPage() {
  const { guildId } = useParams<{ guildId: string }>();
  const [filters, setFilters] = React.useState<AuditLogFilters>({ limit: 25 });
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading, error, refetch } = useAuditLog(guildId, { ...filters, cursor });

  function updateFilter(patch: Partial<AuditLogFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
    setCursorStack([undefined]);
  }

  const columns: DataTableColumn<AuditLogEntryDto>[] = [
    {
      key: 'action',
      header: 'Action',
      render: (row) => <span className="font-medium">{humanizeAction(row.action)}</span>,
    },
    {
      key: 'actor',
      header: 'Actor',
      render: (row) => <span className="font-mono text-xs">{row.actorId}</span>,
    },
    {
      key: 'target',
      header: 'Target',
      render: (row) => (row.targetId ? <span className="font-mono text-xs">{row.targetId}</span> : '—'),
    },
    {
      key: 'source',
      header: 'Source',
      render: (row) => (
        <Badge variant={SOURCE_BADGE[row.source]} className="capitalize">
          {row.source}
        </Badge>
      ),
    },
    { key: 'reason', header: 'Reason', render: (row) => row.reason ?? '—' },
    { key: 'createdAt', header: 'When', render: (row) => formatDateTime(row.createdAt) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit log"
        description="Every configuration change and plugin toggle, from the bot and this dashboard."
        actions={
          <Button variant="outline" asChild>
            <a href={auditExportCsvUrl(guildId)}>
              <Download className="h-4 w-4" />
              Export CSV
            </a>
          </Button>
        }
      />

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Filter by action (e.g. plugin.enable)"
          className="max-w-xs"
          value={filters.action ?? ''}
          onChange={(e) => updateFilter({ action: e.target.value || undefined })}
        />
        <Input
          placeholder="Filter by actor id"
          className="max-w-xs"
          value={filters.actorId ?? ''}
          onChange={(e) => updateFilter({ actorId: e.target.value || undefined })}
        />
        <Select value={String(filters.limit ?? 25)} onValueChange={(v) => updateFilter({ limit: Number(v) })}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[10, 25, 50, 100].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} / page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(row) => row.id}
        loading={isLoading}
        error={error}
        onRetry={() => refetch()}
        emptyTitle="No audit entries"
        emptyDescription="Configuration changes and plugin toggles will show up here."
      />

      <Pagination
        hasPrevious={cursorStack.length > 1}
        hasNext={Boolean(data?.nextCursor)}
        loading={isLoading}
        label={data?.total !== undefined ? `${data.total} total` : undefined}
        onPrevious={() => setCursorStack((prev) => prev.slice(0, -1))}
        onNext={() => data?.nextCursor && setCursorStack((prev) => [...prev, data.nextCursor ?? undefined])}
      />
    </div>
  );
}
