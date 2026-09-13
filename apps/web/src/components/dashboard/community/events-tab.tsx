'use client';

import * as React from 'react';
import { Badge, Card, CardContent, Pagination } from '@pavisie/ui';
import type { CommunityEventDto } from '@pavisie/types/community';
import { useCommunityEvents } from '@/lib/dashboard/community-queries';
import { DataTable, type DataTableColumn } from '../data-table';

export function EventsTab({ guildId }: { guildId: string }) {
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];
  const { data, isLoading, error, refetch } = useCommunityEvents(guildId, cursor);

  const columns: DataTableColumn<CommunityEventDto>[] = [
    { key: 'title', header: 'Event', render: (e) => <span className="font-medium">{e.title}</span> },
    {
      key: 'when',
      header: 'Starts',
      render: (e) => {
        const started = new Date(e.startsAt).getTime() <= Date.now();
        return (
          <span>
            {new Date(e.startsAt).toLocaleString()}{' '}
            {started ? <Badge variant="secondary">Started</Badge> : null}
          </span>
        );
      },
    },
    { key: 'host', header: 'Host', render: (e) => <code className="text-xs">{e.hostId}</code> },
    {
      key: 'rsvps',
      header: 'RSVPs',
      render: (e) => (
        <span>
          ✅ {e.rsvps.going} · ❔ {e.rsvps.maybe} · ❌ {e.rsvps.declined}
        </span>
      ),
    },
    {
      key: 'discordEvent',
      header: 'Discord event',
      render: (e) => (e.discordEventId ? <Badge variant="outline">Linked</Badge> : '—'),
    },
  ];

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <DataTable
          columns={columns}
          rows={data?.items}
          rowKey={(e) => e.id}
          loading={isLoading}
          error={error}
          onRetry={() => refetch()}
          emptyTitle="No events yet"
          emptyDescription="Run /event create in Discord to schedule one."
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
