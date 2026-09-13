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
import type { TwitchChatCommandDto, TwitchChatLevelId } from '@pavisie/types/integrations';
import { useDeleteTwitchChatCommand, useTwitchChatCommands } from '@/lib/dashboard/integrations-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '../confirm-dialog';
import { ErrorState } from '../error-state';
import { TwitchChatCommandDialog } from './twitch-chat-command-dialog';

/** Max custom commands per channel — mirrors `TWITCH_CHAT_MAX_COMMANDS_PER_CHANNEL` in
 * `apps/api/src/lib/integrations/twitch-chat-schemas.ts`. Client-side only; the server is the source
 * of truth and enforces this on create regardless. */
const MAX_COMMANDS_PER_CHANNEL = 50;

export const TWITCH_CHAT_LEVEL_LABEL: Record<TwitchChatLevelId, string> = {
  everyone: 'Everyone',
  subscriber: 'Subscriber',
  vip: 'VIP',
  moderator: 'Moderator',
  broadcaster: 'Broadcaster',
};

export interface TwitchChatCommandsTableProps {
  guildId: string;
  channelId: string;
  /** This channel's current command prefix, only for the empty-state built-ins hint (e.g. "!commands"). */
  prefix: string;
}

export function TwitchChatCommandsTable({ guildId, channelId, prefix }: TwitchChatCommandsTableProps) {
  const { data, isLoading, error, refetch } = useTwitchChatCommands(guildId, channelId);
  const del = useDeleteTwitchChatCommand(guildId);
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TwitchChatCommandDto | null>(null);
  const [deleting, setDeleting] = React.useState<TwitchChatCommandDto | null>(null);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(command: TwitchChatCommandDto) {
    setEditing(command);
    setDialogOpen(true);
  }

  function confirmDelete() {
    if (!deleting) return;
    del.mutate(
      { commandId: deleting.id, channelId },
      {
        onSuccess: () => {
          toast({ title: `Deleted ${prefix}${deleting.name}`, variant: 'success' });
          setDeleting(null);
        },
        onError: (err) =>
          toast({
            title: 'Could not delete the command',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  const atLimit = (data?.length ?? 0) >= MAX_COMMANDS_PER_CHANNEL;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Commands</p>
        <Button
          size="sm"
          variant="outline"
          onClick={openCreate}
          disabled={atLimit}
          title={atLimit ? `Limit of ${MAX_COMMANDS_PER_CHANNEL} commands reached` : undefined}
        >
          Add command
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
          title="No custom commands yet"
          description={`Chat can already use the built-ins ${prefix}commands, ${prefix}uptime, and ${prefix}title.`}
        />
      ) : null}

      {data && data.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Command</TableHead>
              <TableHead>Response</TableHead>
              <TableHead>Cooldown</TableHead>
              <TableHead>Level</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((command) => (
              <TableRow key={command.id}>
                <TableCell className="font-mono text-xs">
                  {prefix}
                  {command.name}
                </TableCell>
                <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                  {command.response}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{command.cooldownSeconds}s</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {TWITCH_CHAT_LEVEL_LABEL[command.minLevel]}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {command.enabled ? 'Yes' : 'No'}
                </TableCell>
                <TableCell className="space-x-1 whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(command)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(command)}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      <TwitchChatCommandDialog
        guildId={guildId}
        channelId={channelId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        command={editing}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${prefix}${deleting?.name}?`}
        description="This can't be undone."
        variant="destructive"
        confirmLabel="Delete"
        loading={del.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
