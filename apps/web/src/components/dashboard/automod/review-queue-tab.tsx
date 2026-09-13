'use client';

import { useParams } from 'next/navigation';
import type { AutomodEventDto } from '@pavisie/types';
import { Badge, Button, PageHeader, useToast } from '@pavisie/ui';
import { useAutomodEvents, useAutomodRules, useReviewAutomodEvent } from '@/lib/dashboard/automod-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { DataTable } from '../data-table';

/** False-positive review queue (TASK: "Review queue tab (pending events with Confirm/False positive)"). */
export function ReviewQueueTab() {
  const { guildId } = useParams<{ guildId: string }>();
  const { data, isLoading, error, refetch } = useAutomodEvents(guildId, {
    reviewStatus: 'PENDING',
    limit: 50,
  });
  const { data: rules } = useAutomodRules(guildId);
  const review = useReviewAutomodEvent(guildId);
  const { toast } = useToast();

  const ruleNameById = new Map((rules ?? []).map((r) => [r.id, r.name]));

  function decide(event: AutomodEventDto, status: 'CONFIRMED' | 'FALSE_POSITIVE') {
    review.mutate(
      { eventId: event.id, reviewStatus: status },
      {
        onSuccess: () =>
          toast({
            title: status === 'CONFIRMED' ? 'Marked as confirmed violation' : 'Marked as false positive',
            variant: 'success',
          }),
        onError: (err) =>
          toast({
            title: 'Could not update the event',
            description: err instanceof ApiClientError ? err.message : undefined,
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Review queue"
        description="Automod matches waiting for a moderator to confirm or dismiss."
      />

      <DataTable
        columns={[
          {
            key: 'rule',
            header: 'Rule',
            render: (e: AutomodEventDto) => ruleNameById.get(e.ruleId) ?? e.action,
          },
          {
            key: 'user',
            header: 'User',
            render: (e: AutomodEventDto) => <span className="font-mono text-xs">{e.userId}</span>,
          },
          {
            key: 'channel',
            header: 'Channel',
            render: (e: AutomodEventDto) =>
              e.channelId ? <span className="font-mono text-xs">{e.channelId}</span> : '—',
          },
          {
            key: 'dryRun',
            header: 'Mode',
            render: (e: AutomodEventDto) =>
              e.dryRun ? <Badge variant="secondary">Dry run</Badge> : <Badge variant="outline">Live</Badge>,
          },
          {
            key: 'when',
            header: 'When',
            render: (e: AutomodEventDto) => new Date(e.createdAt).toLocaleString(),
          },
          {
            key: 'actions',
            header: '',
            className: 'text-right',
            render: (e: AutomodEventDto) => (
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => decide(e, 'CONFIRMED')}
                  disabled={review.isPending}
                >
                  Confirm violation
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => decide(e, 'FALSE_POSITIVE')}
                  disabled={review.isPending}
                >
                  False positive
                </Button>
              </div>
            ),
          },
        ]}
        rows={data?.items}
        rowKey={(e) => e.id}
        loading={isLoading}
        error={error}
        onRetry={() => refetch()}
        emptyTitle="Nothing pending review"
        emptyDescription="Matches show up here until a moderator confirms or dismisses them."
      />
    </div>
  );
}
