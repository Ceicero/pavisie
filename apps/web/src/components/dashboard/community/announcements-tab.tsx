'use client';

import * as React from 'react';
import { Badge, Button, Card, CardContent, Pagination, useToast } from '@pavisie/ui';
import type { AnnouncementDto } from '@pavisie/types/community';
import { ApiClientError } from '@/lib/dashboard/api';
import { useCancelAnnouncement, useCommunityAnnouncements } from '@/lib/dashboard/community-queries';
import { ConfirmDialog } from '../confirm-dialog';
import { DataTable, type DataTableColumn } from '../data-table';

function formatSchedule(a: AnnouncementDto): string {
  if (a.cron) return `Repeats: ${a.cron}`;
  if (a.runAt) return `Once: ${new Date(a.runAt).toLocaleString()}`;
  return 'Unscheduled';
}

export function AnnouncementsTab({ guildId }: { guildId: string }) {
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];
  const { data, isLoading, error, refetch } = useCommunityAnnouncements(guildId, cursor);
  const cancelMutation = useCancelAnnouncement(guildId);
  const { toast } = useToast();
  const [cancelling, setCancelling] = React.useState<AnnouncementDto | null>(null);

  function handleConfirmCancel() {
    if (!cancelling) return;
    cancelMutation.mutate(cancelling.id, {
      onSuccess: () => {
        toast({ title: 'Announcement cancelled', variant: 'success' });
        setCancelling(null);
      },
      onError: (err) =>
        toast({
          title: 'Could not cancel',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  const columns: DataTableColumn<AnnouncementDto>[] = [
    {
      key: 'content',
      header: 'Message',
      render: (a) => (
        <span>
          {a.content.content.length > 60
            ? `${a.content.content.slice(0, 60)}…`
            : a.content.content || '(empty)'}
        </span>
      ),
    },
    { key: 'channel', header: 'Channel', render: (a) => <code className="text-xs">#{a.channelId}</code> },
    { key: 'schedule', header: 'Schedule', render: (a) => formatSchedule(a) },
    {
      key: 'status',
      header: 'Status',
      render: (a) => (
        <Badge variant={a.enabled ? 'success' : 'secondary'}>{a.enabled ? 'Scheduled' : 'Cancelled'}</Badge>
      ),
    },
    {
      key: 'lastRun',
      header: 'Last sent',
      render: (a) => (a.lastRunAt ? new Date(a.lastRunAt).toLocaleString() : 'Never'),
    },
    {
      key: 'actions',
      header: '',
      render: (a) =>
        a.enabled ? (
          <Button size="sm" variant="destructive" onClick={() => setCancelling(a)}>
            Cancel
          </Button>
        ) : null,
    },
  ];

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <DataTable
          columns={columns}
          rows={data?.items}
          rowKey={(a) => a.id}
          loading={isLoading}
          error={error}
          onRetry={() => refetch()}
          emptyTitle="No scheduled announcements"
          emptyDescription="Run /announce schedule in Discord to set one up."
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

      <ConfirmDialog
        open={Boolean(cancelling)}
        onOpenChange={(open) => !open && setCancelling(null)}
        title="Cancel this announcement?"
        description="It will no longer send. This can't be undone from here — reschedule with /announce schedule if needed."
        confirmLabel="Cancel announcement"
        variant="destructive"
        loading={cancelMutation.isPending}
        onConfirm={handleConfirmCancel}
      />
    </Card>
  );
}
