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
import { useDeleteInboundWebhook, useInboundWebhooks } from '@/lib/dashboard/integrations-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '../confirm-dialog';
import { ErrorState } from '../error-state';

export function InboundWebhooksList({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useInboundWebhooks(guildId);
  const del = useDeleteInboundWebhook(guildId);
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);

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
        title="No inbound webhooks yet"
        description="Create one to receive GitHub or generic JSON events as Discord messages."
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

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last event</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((hook) => (
            <TableRow key={hook.id}>
              <TableCell className="font-medium">{hook.name}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{hook.provider}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {hook.channelId ? `#${hook.channelId}` : '—'}
              </TableCell>
              <TableCell>
                {hook.active ? (
                  <Badge variant="success">Enabled</Badge>
                ) : (
                  <Badge variant="secondary">Disabled</Badge>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {hook.lastDeliveryAt ? new Date(hook.lastDeliveryAt).toLocaleString() : 'never'}
              </TableCell>
              <TableCell>
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
        description="Its URL stops accepting events immediately. This can't be undone."
        variant="destructive"
        confirmLabel="Delete"
        loading={del.isPending}
        onConfirm={handleDelete}
      />
    </>
  );
}
