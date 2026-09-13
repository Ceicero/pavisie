'use client';

import * as React from 'react';
import {
  Badge,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Pagination,
  Skeleton,
} from '@pavisie/ui';
import type { PollDto } from '@pavisie/types/community';
import { useCommunityPolls, usePollResults } from '@/lib/dashboard/community-queries';
import { DataTable, type DataTableColumn } from '../data-table';

function ResultsBars({ guildId, pollId }: { guildId: string; pollId: string }) {
  const { data, isLoading, error } = usePollResults(guildId, pollId);

  if (error) return <p className="text-sm text-destructive">Could not load results.</p>;
  if (isLoading || !data) return <Skeleton className="h-40 w-full" />;

  const max = Math.max(1, ...data.options.map((o) => o.votes));

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {data.totalVotes} total vote{data.totalVotes === 1 ? '' : 's'} ·{' '}
        {data.anonymous ? 'anonymous' : 'public votes'} · {data.closed ? 'closed' : 'open'}
      </p>
      {data.options.map((option) => {
        const pct = data.totalVotes > 0 ? Math.round((option.votes / data.totalVotes) * 100) : 0;
        return (
          <div key={option.id} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{option.label}</span>
              <span className="text-muted-foreground">
                {option.votes} ({pct}%)
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${(option.votes / max) * 100}%` }}
              />
            </div>
            {option.voterIds && option.voterIds.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {option.voterIds.length} voter(s) recorded (anonymous polls never expose this)
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function PollsTab({ guildId }: { guildId: string }) {
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];
  const { data, isLoading, error, refetch } = useCommunityPolls(guildId, cursor);
  const [openPollId, setOpenPollId] = React.useState<string | null>(null);

  const columns: DataTableColumn<PollDto>[] = [
    { key: 'question', header: 'Question', render: (p) => <span className="font-medium">{p.question}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (p) => (
        <Badge variant={p.closed ? 'secondary' : 'success'}>{p.closed ? 'Closed' : 'Open'}</Badge>
      ),
    },
    { key: 'options', header: 'Options', render: (p) => p.options.length },
    { key: 'votes', header: 'Total votes', render: (p) => p.totalVotes },
    {
      key: 'flags',
      header: 'Settings',
      render: (p) =>
        [p.anonymous ? 'anonymous' : null, p.multiSelect ? 'multi-select' : null]
          .filter(Boolean)
          .join(', ') || '—',
    },
  ];

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <DataTable
          columns={columns}
          rows={data?.items}
          rowKey={(p) => p.id}
          loading={isLoading}
          error={error}
          onRetry={() => refetch()}
          emptyTitle="No polls yet"
          emptyDescription="Run /poll create in Discord to start one."
          onRowClick={(p) => setOpenPollId(p.id)}
        />
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={Boolean(data?.nextCursor)}
          loading={isLoading}
          label={`${data?.items.length ?? 0} shown`}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </CardContent>

      <Dialog open={Boolean(openPollId)} onOpenChange={(open) => !open && setOpenPollId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Poll results</DialogTitle>
          </DialogHeader>
          {openPollId ? <ResultsBars guildId={guildId} pollId={openPollId} /> : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
