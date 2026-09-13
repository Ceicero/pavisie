'use client';

import * as React from 'react';
import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@pavisie/ui';
import { useAlertConnections, useDeleteAlertConnection } from '@/lib/dashboard/integrations-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '../confirm-dialog';
import { ErrorState } from '../error-state';

const STATUS_VARIANT: Record<string, 'success' | 'destructive' | 'secondary' | 'warning'> = {
  connected: 'success',
  error: 'destructive',
  disconnected: 'secondary',
  pending: 'warning',
};

export function AlertsList({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useAlertConnections(guildId);
  const del = useDeleteAlertConnection(guildId);
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <EmptyState
        title="No alert watches yet"
        description="Add a Twitch, YouTube, Reddit, or Steam watch from one of the provider cards above."
      />
    );
  }

  function handleDelete() {
    if (!pendingDelete) return;
    del.mutate(pendingDelete, {
      onSuccess: () => {
        toast({ title: 'Alert watch removed', variant: 'success' });
        setPendingDelete(null);
      },
      onError: (err) =>
        toast({
          title: 'Could not remove watch',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Provider</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last sync</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((conn) => (
            <TableRow key={conn.id}>
              <TableCell className="font-medium">{conn.provider}</TableCell>
              <TableCell className="font-mono text-xs">{conn.target ?? conn.label ?? '—'}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {conn.channelId ? `#${conn.channelId}` : '—'}
              </TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANT[conn.status] ?? 'secondary'}>{conn.status}</Badge>
                {conn.status === 'error' && conn.lastError ? (
                  <p className="mt-1 max-w-xs text-xs text-destructive">{conn.lastError}</p>
                ) : null}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {conn.lastSyncAt ? new Date(conn.lastSyncAt).toLocaleString() : 'never'}
              </TableCell>
              <TableCell>
                <Button size="sm" variant="ghost" onClick={() => setPendingDelete(conn.id)}>
                  Remove
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Remove this alert watch?"
        description="Alerts for this target will stop. You can add it again later."
        variant="destructive"
        confirmLabel="Remove"
        loading={del.isPending}
        onConfirm={handleDelete}
      />
    </>
  );
}
