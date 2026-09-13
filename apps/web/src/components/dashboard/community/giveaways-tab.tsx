'use client';

import * as React from 'react';
import { Badge, Card, CardContent, Pagination } from '@pavisie/ui';
import type { GiveawayDto } from '@pavisie/types/community';
import { useCommunityGiveaways } from '@/lib/dashboard/community-queries';
import { DataTable, type DataTableColumn } from '../data-table';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function GiveawaysTab({ guildId }: { guildId: string }) {
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];
  const { data, isLoading, error, refetch } = useCommunityGiveaways(guildId, cursor);

  const columns: DataTableColumn<GiveawayDto>[] = [
    { key: 'prize', header: 'Prize', render: (g) => <span className="font-medium">{g.prize}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (g) => (
        <Badge variant={g.ended ? 'secondary' : 'success'}>{g.ended ? 'Ended' : 'Active'}</Badge>
      ),
    },
    { key: 'winnerCount', header: 'Winner count', render: (g) => g.winnerCount },
    { key: 'entries', header: 'Entries', render: (g) => g.entryCount },
    {
      key: 'timing',
      header: 'Ends / result',
      render: (g) =>
        g.ended
          ? g.winnerIds.length > 0
            ? `Drawn: ${g.winnerIds.length} winner(s)`
            : 'No eligible entries'
          : formatDate(g.endsAt),
    },
  ];

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <DataTable
          columns={columns}
          rows={data?.items}
          rowKey={(g) => g.id}
          loading={isLoading}
          error={error}
          onRetry={() => refetch()}
          emptyTitle="No giveaways yet"
          emptyDescription="Run /giveaway start in Discord to launch one."
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
    </Card>
  );
}
