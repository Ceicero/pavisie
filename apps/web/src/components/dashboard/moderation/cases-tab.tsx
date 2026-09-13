'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import type { ModerationCaseDto } from '@pavisie/types';
import {
  Badge,
  Button,
  Input,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@pavisie/ui';
import { DataTable, type DataTableColumn } from '../data-table';
import { formatDateTime } from '@/lib/dashboard/format';
import {
  moderationCasesExportCsvUrl,
  useModerationCases,
  type CasesFilters,
} from '@/lib/dashboard/moderation-queries';
import { CaseDetailDrawer } from './case-detail-drawer';

const CASE_TYPES = [
  'WARN',
  'TIMEOUT',
  'UNTIMEOUT',
  'KICK',
  'BAN',
  'UNBAN',
  'SOFTBAN',
  'PURGE',
  'LOCK',
  'UNLOCK',
  'SLOWMODE',
  'NICK',
  'ROLE_ADD',
  'ROLE_REMOVE',
  'QUARANTINE',
  'NOTE',
];

const TYPE_BADGE: Record<
  string,
  'default' | 'secondary' | 'outline' | 'destructive' | 'success' | 'warning'
> = {
  WARN: 'warning',
  TIMEOUT: 'warning',
  UNTIMEOUT: 'success',
  KICK: 'destructive',
  BAN: 'destructive',
  UNBAN: 'success',
  SOFTBAN: 'destructive',
  PURGE: 'secondary',
};

export function CasesTab({ guildId }: { guildId: string }) {
  const [filters, setFilters] = React.useState<CasesFilters>({ limit: 25 });
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const [selectedCase, setSelectedCase] = React.useState<ModerationCaseDto | null>(null);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading, error, refetch } = useModerationCases(guildId, { ...filters, cursor });

  function updateFilter(patch: Partial<CasesFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
    setCursorStack([undefined]);
  }

  const columns: DataTableColumn<ModerationCaseDto>[] = [
    { key: 'number', header: '#', render: (row) => <span className="font-mono">{row.caseNumber}</span> },
    {
      key: 'type',
      header: 'Type',
      render: (row) => (
        <Badge variant={TYPE_BADGE[row.type] ?? 'outline'} className="capitalize">
          {row.type.toLowerCase().replace(/_/g, ' ')}
        </Badge>
      ),
    },
    {
      key: 'target',
      header: 'Target',
      render: (row) => <span className="font-mono text-xs">{row.targetId}</span>,
    },
    {
      key: 'moderator',
      header: 'Moderator',
      render: (row) => <span className="font-mono text-xs">{row.moderatorId}</span>,
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (row) => <span className="truncate">{row.reason ?? '—'}</span>,
    },
    { key: 'when', header: 'When', render: (row) => formatDateTime(row.createdAt) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Filter by target user id"
          className="max-w-xs"
          value={filters.targetId ?? ''}
          onChange={(e) => updateFilter({ targetId: e.target.value || undefined })}
        />
        <Select
          value={filters.type ?? 'all'}
          onValueChange={(v) => updateFilter({ type: v === 'all' ? undefined : v })}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {CASE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" asChild className="ml-auto">
          <a href={moderationCasesExportCsvUrl(guildId)}>
            <Download className="h-4 w-4" />
            Export CSV
          </a>
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(row) => row.id}
        loading={isLoading}
        error={error}
        onRetry={() => refetch()}
        onRowClick={(row) => setSelectedCase(row)}
        emptyTitle="No cases yet"
        emptyDescription="Moderation actions taken with /mod will show up here."
      />

      <Pagination
        hasPrevious={cursorStack.length > 1}
        hasNext={Boolean(data?.nextCursor)}
        loading={isLoading}
        onPrevious={() => setCursorStack((prev) => prev.slice(0, -1))}
        onNext={() => data?.nextCursor && setCursorStack((prev) => [...prev, data.nextCursor ?? undefined])}
      />

      <CaseDetailDrawer
        guildId={guildId}
        caseRow={selectedCase}
        onOpenChange={(open) => !open && setSelectedCase(null)}
      />
    </div>
  );
}
