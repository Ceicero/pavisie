'use client';

import * as React from 'react';
import {
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
import type { TwitchChatTimerDto } from '@pavisie/types/integrations';
import { useDeleteTwitchChatTimer, useTwitchChatTimers } from '@/lib/dashboard/integrations-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '../confirm-dialog';
import { ErrorState } from '../error-state';
import { TwitchChatTimerDialog } from './twitch-chat-timer-dialog';

/** Max timers per channel — mirrors `TWITCH_CHAT_MAX_TIMERS_PER_CHANNEL` in
 * `apps/api/src/lib/integrations/twitch-chat-schemas.ts`. Client-side only; the server enforces this. */
const MAX_TIMERS_PER_CHANNEL = 10;

export interface TwitchChatTimersTableProps {
  guildId: string;
  channelId: string;
}

export function TwitchChatTimersTable({ guildId, channelId }: TwitchChatTimersTableProps) {
  const { data, isLoading, error, refetch } = useTwitchChatTimers(guildId, channelId);
  const del = useDeleteTwitchChatTimer(guildId);
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TwitchChatTimerDto | null>(null);
  const [deleting, setDeleting] = React.useState<TwitchChatTimerDto | null>(null);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(timer: TwitchChatTimerDto) {
    setEditing(timer);
    setDialogOpen(true);
  }

  function confirmDelete() {
    if (!deleting) return;
    del.mutate(
      { timerId: deleting.id, channelId },
      {
        onSuccess: () => {
          toast({ title: `Deleted timer "${deleting.name}"`, variant: 'success' });
          setDeleting(null);
        },
        onError: (err) =>
          toast({
            title: 'Could not delete the timer',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  const atLimit = (data?.length ?? 0) >= MAX_TIMERS_PER_CHANNEL;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Timers</p>
        <Button
          size="sm"
          variant="outline"
          onClick={openCreate}
          disabled={atLimit}
          title={atLimit ? `Limit of ${MAX_TIMERS_PER_CHANNEL} timers reached` : undefined}
        >
          Add timer
        </Button>
      </div>

      {error ? <ErrorState error={error} onRetry={() => refetch()} /> : null}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : null}

      {!isLoading && !error && (!data || data.length === 0) ? (
        <EmptyState
          title="No timers yet"
          description="Timers post a message to chat on a fixed interval, whether or not anyone's talking."
        />
      ) : null}

      {data && data.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Every</TableHead>
              <TableHead>Last fired</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((timer) => (
              <TableRow key={timer.id}>
                <TableCell className="font-medium">{timer.name}</TableCell>
                <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                  {timer.message}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{timer.intervalMinutes}m</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {timer.lastFiredAt ? new Date(timer.lastFiredAt).toLocaleString() : 'never'}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {timer.enabled ? 'Yes' : 'No'}
                </TableCell>
                <TableCell className="space-x-1 whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(timer)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(timer)}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      <TwitchChatTimerDialog
        guildId={guildId}
        channelId={channelId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        timer={editing}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete timer "${deleting?.name}"?`}
        description="This can't be undone."
        variant="destructive"
        confirmLabel="Delete"
        loading={del.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
