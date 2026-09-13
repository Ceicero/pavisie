'use client';

import {
  Badge,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@pavisie/ui';
import { useOutboundDeliveries } from '@/lib/dashboard/integrations-queries';
import { ErrorState } from '../error-state';

export interface DeliveriesDialogProps {
  guildId: string;
  endpointId: string | null;
  endpointName?: string;
  onOpenChange: (open: boolean) => void;
}

export function DeliveriesDialog({ guildId, endpointId, endpointName, onOpenChange }: DeliveriesDialogProps) {
  const { data, isLoading, error, refetch } = useOutboundDeliveries(guildId, endpointId ?? undefined);

  return (
    <Dialog open={endpointId !== null} onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Recent deliveries{endpointName ? ` — ${endpointName}` : ''}</DialogTitle>
        </DialogHeader>

        {error ? <ErrorState error={error} onRetry={() => refetch()} /> : null}

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : data && data.items.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Attempt</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(d.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{d.attempt}</TableCell>
                  <TableCell>{d.status ?? '—'}</TableCell>
                  <TableCell>
                    {d.success ? (
                      <Badge variant="success">Delivered</Badge>
                    ) : (
                      <Badge variant="destructive">{d.error ?? 'Failed'}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">No deliveries yet.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
