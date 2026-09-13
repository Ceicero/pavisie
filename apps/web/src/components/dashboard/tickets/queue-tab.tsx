'use client';

import * as React from 'react';
import type { TicketQueueItemDto } from '@pavisie/types/tickets';
import {
  Badge,
  Input,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@pavisie/ui';
import { formatRelativeTime } from '@/lib/dashboard/format';
import { useTicketQueue, type TicketQueueFilters } from '@/lib/dashboard/tickets-queries';
import { DataTable, type DataTableColumn } from '../data-table';
import { TicketDetailDrawer } from './ticket-detail-drawer';

export interface TicketsQueueTabProps {
  guildId: string;
}

const STATUS_OPTIONS = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'OPEN', label: 'Open' },
  { value: 'CLOSED', label: 'Closed' },
];

export function TicketsQueueTab({ guildId }: TicketsQueueTabProps) {
  const [status, setStatus] = React.useState<'ALL' | 'OPEN' | 'CLOSED'>('OPEN');
  const [tag, setTag] = React.useState('');
  const [cursor, setCursor] = React.useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([]);
  const [selectedTicketId, setSelectedTicketId] = React.useState<string | null>(null);

  const filters: TicketQueueFilters = {
    status: status === 'ALL' ? undefined : status,
    tag: tag.trim() || undefined,
    cursor,
  };
  const { data, isLoading, error, refetch } = useTicketQueue(guildId, filters);

  React.useEffect(() => {
    setCursor(undefined);
    setCursorStack([]);
  }, [status, tag]);

  function goNext() {
    if (!data?.nextCursor) return;
    setCursorStack((prev) => [...prev, cursor]);
    setCursor(data.nextCursor);
  }

  function goPrevious() {
    setCursorStack((prev) => {
      const next = [...prev];
      const previousCursor = next.pop();
      setCursor(previousCursor);
      return next;
    });
  }

  const columns: DataTableColumn<TicketQueueItemDto>[] = [
    { key: 'number', header: '#', render: (t) => `#${t.number}` },
    { key: 'opener', header: 'Opener', render: (t) => t.openerId },
    {
      key: 'subject',
      header: 'Subject',
      render: (t) => t.subject ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'assignee',
      header: 'Assignee',
      render: (t) => t.assigneeId ?? <span className="text-muted-foreground">Unassigned</span>,
    },
    {
      key: 'tags',
      header: 'Tags',
      render: (t) =>
        t.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {t.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'sla',
      header: 'SLA',
      render: (t) =>
        t.status === 'OPEN' && t.slaDueAt ? (
          <Badge variant={t.slaBreached ? 'destructive' : 'outline'}>
            {t.slaBreached ? 'Breached' : 'On track'}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { key: 'age', header: 'Opened', render: (t) => formatRelativeTime(t.createdAt) },
    {
      key: 'status',
      header: 'Status',
      render: (t) => <Badge variant={t.status === 'OPEN' ? 'success' : 'outline'}>{t.status}</Badge>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Filter by tag…"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          className="w-48"
        />
      </div>

      <DataTable
        columns={columns}
        rows={data?.items}
        rowKey={(t) => t.id}
        loading={isLoading}
        error={error}
        onRetry={() => refetch()}
        emptyTitle="No tickets"
        emptyDescription="Tickets opened by members will show up here."
        onRowClick={(t) => setSelectedTicketId(t.id)}
      />

      {data && (data.items.length > 0 || cursor) ? (
        <Pagination
          hasPrevious={cursorStack.length > 0}
          hasNext={data.nextCursor !== null}
          loading={isLoading}
          onPrevious={goPrevious}
          onNext={goNext}
          label={`${data.items.length} ticket${data.items.length === 1 ? '' : 's'}`}
        />
      ) : null}

      <TicketDetailDrawer
        guildId={guildId}
        ticketId={selectedTicketId}
        onOpenChange={(open) => !open && setSelectedTicketId(null)}
      />
    </div>
  );
}
