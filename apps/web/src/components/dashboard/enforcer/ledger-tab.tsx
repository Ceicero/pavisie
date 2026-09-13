'use client';

import * as React from 'react';
import { Download } from 'lucide-react';
import type { EnforcerRecordDto } from '@pavisie/types';
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@pavisie/ui';
import {
  enforcerRecordsExportCsvUrl,
  useEnforcerRecords,
  type EnforcerRecordFilters,
} from '@/lib/dashboard/enforcer-queries';
import { DataTable, type DataTableColumn } from '../data-table';
import { formatDateTime } from '@/lib/dashboard/format';

const KINDS = ['FLAG', 'DECISION', 'APPEAL_OPENED', 'APPEAL_DECIDED', 'NOTE'];

export interface LedgerTabProps {
  guildId: string;
}

function ContextSnapshotView({ snapshot }: { snapshot: unknown }) {
  if (!Array.isArray(snapshot) || snapshot.length === 0)
    return <p className="text-xs text-muted-foreground">No stored context snapshot.</p>;
  return (
    <div className="space-y-1">
      {(snapshot as { authorId: string; excerpt: string }[]).map((m, i) => (
        <p key={i} className="text-xs">
          <span className="font-mono text-muted-foreground">{m.authorId}</span>: {m.excerpt}
        </p>
      ))}
    </div>
  );
}

export function LedgerTab({ guildId }: LedgerTabProps) {
  const [filters, setFilters] = React.useState<EnforcerRecordFilters>({ limit: 25 });
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];
  const [detail, setDetail] = React.useState<EnforcerRecordDto | null>(null);

  const { data, isLoading, error, refetch } = useEnforcerRecords(guildId, { ...filters, cursor });

  function updateFilter(patch: Partial<EnforcerRecordFilters>) {
    setFilters((prev) => ({ ...prev, ...patch }));
    setCursorStack([undefined]);
  }

  const columns: DataTableColumn<EnforcerRecordDto>[] = [
    {
      key: 'record',
      header: 'Record',
      render: (r) => <span className="font-mono text-xs">#E-{r.recordNumber}</span>,
    },
    { key: 'kind', header: 'Kind', render: (r) => <Badge variant="outline">{r.kind}</Badge> },
    { key: 'user', header: 'User', render: (r) => <span className="font-mono text-xs">{r.userId}</span> },
    { key: 'decision', header: 'Decision / status', render: (r) => r.decision ?? r.status ?? '—' },
    { key: 'policy', header: 'Policy', render: (r) => r.policyName ?? '—' },
    { key: 'when', header: 'When', render: (r) => formatDateTime(r.createdAt) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ledger"
        description="Every flag and decision, immutable and searchable."
        actions={
          <Button variant="outline" asChild>
            <a href={enforcerRecordsExportCsvUrl(guildId, filters)}>
              <Download className="h-4 w-4" />
              Export CSV
            </a>
          </Button>
        }
      />

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Filter by user id"
          className="max-w-xs"
          value={filters.userId ?? ''}
          onChange={(e) => updateFilter({ userId: e.target.value || undefined })}
        />
        <Select
          value={filters.kind ?? '__all__'}
          onValueChange={(v) => updateFilter({ kind: v === '__all__' ? undefined : v })}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All kinds</SelectItem>
            {KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Since, e.g. 7d, 24h"
          className="max-w-xs"
          value={filters.since ?? ''}
          onChange={(e) => updateFilter({ since: e.target.value || undefined })}
        />
      </div>

      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(r) => r.id}
        loading={isLoading}
        error={error}
        onRetry={() => refetch()}
        onRowClick={(r) => setDetail(r)}
        emptyTitle="No records"
        emptyDescription="Flags and decisions will show up here."
      />

      <Pagination
        hasPrevious={cursorStack.length > 1}
        hasNext={Boolean(data?.nextCursor)}
        loading={isLoading}
        onPrevious={() => setCursorStack((prev) => prev.slice(0, -1))}
        onNext={() => data?.nextCursor && setCursorStack((prev) => [...prev, data.nextCursor ?? undefined])}
      />

      <Sheet open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Record #E-{detail?.recordNumber}</SheetTitle>
          </SheetHeader>
          {detail ? (
            <div className="space-y-3 py-4 text-sm">
              <p>
                <span className="text-muted-foreground">Kind:</span> {detail.kind}
              </p>
              <p>
                <span className="text-muted-foreground">User:</span>{' '}
                <span className="font-mono">{detail.userId}</span>
              </p>
              <p>
                <span className="text-muted-foreground">Source:</span> {detail.source}
              </p>
              {detail.policyName ? (
                <p>
                  <span className="text-muted-foreground">Policy:</span> {detail.policyName}
                </p>
              ) : null}
              {detail.matcherSummary ? (
                <p>
                  <span className="text-muted-foreground">Matched:</span> {detail.matcherSummary}
                </p>
              ) : null}
              {detail.decision ? (
                <p>
                  <span className="text-muted-foreground">Decision:</span> {detail.decision}{' '}
                  {detail.decidedBy ? `by ${detail.decidedBy}` : ''}
                </p>
              ) : null}
              {detail.decisionReason ? (
                <p>
                  <span className="text-muted-foreground">Reason:</span> {detail.decisionReason}
                </p>
              ) : null}
              {detail.caseId ? (
                <p>
                  <span className="text-muted-foreground">Case id:</span>{' '}
                  <span className="font-mono text-xs">{detail.caseId}</span>
                </p>
              ) : null}
              {detail.excerpt ? (
                <div>
                  <p className="text-muted-foreground">Excerpt</p>
                  <p className="rounded-md border border-border p-2">{detail.excerpt}</p>
                </div>
              ) : null}
              {detail.messageJumpUrl ? (
                <a
                  className="text-primary underline"
                  href={detail.messageJumpUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Jump to message
                </a>
              ) : null}
              <div>
                <p className="text-muted-foreground">Context snapshot</p>
                <ContextSnapshotView snapshot={detail.contextSnapshot} />
              </div>
              <p className="text-xs text-muted-foreground">Created {formatDateTime(detail.createdAt)}</p>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
