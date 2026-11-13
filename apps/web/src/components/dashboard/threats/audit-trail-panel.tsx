'use client';

import * as React from 'react';
import type { ModerationAuditEntryDto, ModerationCaseDto } from '@pavisie/types';
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
  useToast,
} from '@pavisie/ui';
import { DataTable, type DataTableColumn } from '../data-table';
import { formatDateTime, humanizeAction } from '@/lib/dashboard/format';
import { ApiClientError, apiFetch } from '@/lib/dashboard/api';
import {
  canOpenCaseDrawer,
  useThreatAudit,
  type ThreatAuditFilters,
} from '@/lib/dashboard/threats-queries';
import { CaseDetailDrawer } from '../moderation/case-detail-drawer';

const SOURCE_BADGE: Record<ModerationAuditEntryDto['source'], 'default' | 'secondary' | 'outline'> = {
  bot: 'outline',
  dashboard: 'default',
  system: 'secondary',
};

export function AuditTrailPanel({ guildId }: { guildId: string }) {
  const [filters, setFilters] = React.useState<ThreatAuditFilters>({ limit: 25 });
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const [selectedCase, setSelectedCase] = React.useState<ModerationCaseDto | null>(null);
  const cursor = cursorStack[cursorStack.length - 1];
  const { toast } = useToast();

  const { data, isLoading, error, refetch } = useThreatAudit(guildId, { ...filters, cursor });

  function updateFilter(patch: Partial<ThreatAuditFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
    setCursorStack([undefined]);
  }

  async function openCase(caseNumber: number) {
    try {
      const row = await apiFetch<ModerationCaseDto>(`/guilds/${guildId}/moderation/cases/${caseNumber}`);
      setSelectedCase(row);
    } catch (err) {
      toast({
        title: 'Could not load case',
        description: err instanceof ApiClientError ? err.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  }

  const columns: DataTableColumn<ModerationAuditEntryDto>[] = [
    {
      key: 'action',
      header: 'Action',
      render: (row) => <span className="font-medium">{humanizeAction(row.action)}</span>,
    },
    {
      key: 'case',
      header: 'Case',
      render: (row) =>
        canOpenCaseDrawer(row) ? (
          <Button
            variant="link"
            className="h-auto p-0 font-mono"
            onClick={(event) => {
              event.stopPropagation();
              void openCase(row.caseNumber!);
            }}
          >
            #{row.caseNumber}
            {row.caseType ? ` ${row.caseType}` : ''}
          </Button>
        ) : (
          '—'
        ),
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
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Moderation audit trail</h2>
        <p className="text-sm text-muted-foreground">
          One row per moderation action — cases, warnings, appeals, notes, and settings — newest first.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Input
          aria-label="Filter by action"
          placeholder="Filter by action (e.g. moderation.case.create)"
          className="w-full sm:max-w-xs"
          value={filters.action ?? ''}
          onChange={(e) => updateFilter({ action: e.target.value || undefined })}
        />
        <Input
          aria-label="Filter by actor id"
          placeholder="Filter by actor id"
          className="w-full sm:max-w-xs"
          value={filters.actorId ?? ''}
          onChange={(e) => updateFilter({ actorId: e.target.value || undefined })}
        />
        <Select value={String(filters.limit ?? 25)} onValueChange={(v) => updateFilter({ limit: Number(v) })}>
          <SelectTrigger aria-label="Entries per page" className="w-full sm:w-32">
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
        emptyTitle="No moderation audit entries"
        emptyDescription="Moderation actions taken in this server will show up here."
        onRowClick={(row) => {
          if (canOpenCaseDrawer(row)) void openCase(row.caseNumber!);
        }}
      />

      <Pagination
        hasPrevious={cursorStack.length > 1}
        hasNext={Boolean(data?.nextCursor)}
        loading={isLoading}
        label={data?.total !== undefined ? `${data.total} total` : undefined}
        onPrevious={() => setCursorStack((prev) => prev.slice(0, -1))}
        onNext={() => data?.nextCursor && setCursorStack((prev) => [...prev, data.nextCursor ?? undefined])}
      />

      <CaseDetailDrawer
        guildId={guildId}
        caseRow={selectedCase}
        onOpenChange={(open) => !open && setSelectedCase(null)}
      />
    </section>
  );
}
