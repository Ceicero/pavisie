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
import {
  useDeleteOutboundWebhook,
  useOutboundWebhooks,
  useTestOutboundWebhook,
} from '@/lib/dashboard/integrations-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '../confirm-dialog';
import { ErrorState } from '../error-state';
import { DeliveriesDialog } from './deliveries-dialog';

export function OutboundWebhooksList({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useOutboundWebhooks(guildId);
  const del = useDeleteOutboundWebhook(guildId);
  const test = useTestOutboundWebhook(guildId);
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
  const [viewingDeliveries, setViewingDeliveries] = React.useState<{ id: string; name: string } | null>(null);

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <EmptyState
        title="No outbound webhooks yet"
        description="Notify an external service whenever something happens — a moderation case, a ticket, a level-up."
      />
    );
  }

  function handleDelete() {
    if (!pendingDelete) return;
    del.mutate(pendingDelete, {
      onSuccess: () => {
        toast({ title: 'Webhook deleted', variant: 'success' });
        setPendingDelete(null);
      },
      onError: (err) =>
        toast({
          title: 'Could not delete webhook',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  function handleTest(id: string) {
    test.mutate(id, {
      onSuccess: () =>
        toast({
          title: 'Test delivery queued',
          description: 'Check the deliveries list in a moment.',
          variant: 'success',
        }),
      onError: (err) =>
        toast({
          title: 'Could not queue test delivery',
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
            <TableHead>Name</TableHead>
            <TableHead>Events</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Failures</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((hook) => (
            <TableRow key={hook.id}>
              <TableCell className="font-medium">{hook.name}</TableCell>
              <TableCell className="max-w-xs text-xs text-muted-foreground">
                {hook.events.join(', ')}
              </TableCell>
              <TableCell>
                {hook.active ? (
                  <Badge variant="success">Enabled</Badge>
                ) : (
                  <Badge variant="secondary">Auto-disabled</Badge>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{hook.failureCount}</TableCell>
              <TableCell className="space-x-1 whitespace-nowrap">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleTest(hook.id)}
                  disabled={test.isPending}
                >
                  Test
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setViewingDeliveries({ id: hook.id, name: hook.name })}
                >
                  Deliveries
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPendingDelete(hook.id)}>
                  Delete
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete this webhook?"
        description="Deliveries stop immediately. This can't be undone."
        variant="destructive"
        confirmLabel="Delete"
        loading={del.isPending}
        onConfirm={handleDelete}
      />

      <DeliveriesDialog
        guildId={guildId}
        endpointId={viewingDeliveries?.id ?? null}
        endpointName={viewingDeliveries?.name}
        onOpenChange={(open) => !open && setViewingDeliveries(null)}
      />
    </>
  );
}
