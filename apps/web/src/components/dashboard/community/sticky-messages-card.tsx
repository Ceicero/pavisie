'use client';

import * as React from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  useToast,
} from '@pavisie/ui';
import type { StickyMessageDto } from '@pavisie/types/community';
import { ApiClientError } from '@/lib/dashboard/api';
import { useCommunityStickies, useDeleteSticky } from '@/lib/dashboard/community-queries';
import { useGuildChannels } from '@/lib/dashboard/queries';
import { ConfirmDialog } from '../confirm-dialog';
import { DataTable, type DataTableColumn } from '../data-table';

const PREVIEW_CHARS = 60;

/** One-line preview of a sticky: its text, else the embed title/description, truncated. */
export function stickyPreviewText(sticky: StickyMessageDto, maxChars = PREVIEW_CHARS): string {
  const source = sticky.content?.trim() || sticky.embed?.title || sticky.embed?.description || '';
  const oneLine = source.replace(/\s+/g, ' ').trim();
  if (!oneLine) return sticky.embed?.imageUrl ? '(image embed)' : '(empty)';
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine;
}

/** Sticky messages card of the community page's Channels tab (`channels-tab.tsx`). */
export function StickyMessagesCard({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useCommunityStickies(guildId);
  const { data: channels } = useGuildChannels(guildId);
  const deleteMutation = useDeleteSticky(guildId);
  const { toast } = useToast();
  const [removing, setRemoving] = React.useState<StickyMessageDto | null>(null);

  const channelName = React.useCallback(
    (channelId: string) => channels?.find((c) => c.id === channelId)?.name ?? null,
    [channels],
  );

  function handleConfirmRemove() {
    if (!removing) return;
    deleteMutation.mutate(removing.id, {
      onSuccess: () => {
        toast({
          title: 'Sticky removed',
          description:
            'The bot will stop re-posting it. Its last posted copy stays until you delete it in Discord.',
          variant: 'success',
        });
        setRemoving(null);
      },
      onError: (err) =>
        toast({
          title: 'Could not remove',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  const columns: DataTableColumn<StickyMessageDto>[] = [
    {
      key: 'channel',
      header: 'Channel',
      render: (s) => {
        const name = channelName(s.channelId);
        return name ? (
          <span className="font-medium">#{name}</span>
        ) : (
          <code className="text-xs">#{s.channelId}</code>
        );
      },
    },
    {
      key: 'preview',
      header: 'Preview',
      render: (s) => (
        <span className="inline-flex items-center gap-2">
          <span>{stickyPreviewText(s)}</span>
          {s.embed ? <Badge variant="secondary">Embed</Badge> : null}
        </span>
      ),
    },
    { key: 'cooldown', header: 'Cooldown', render: (s) => `${s.cooldownSeconds}s` },
    {
      key: 'lastPosted',
      header: 'Last re-post',
      render: (s) => (s.lastPostedAt ? new Date(s.lastPostedAt).toLocaleString() : 'Never'),
    },
    {
      key: 'actions',
      header: '',
      render: (s) => (
        <Button size="sm" variant="destructive" onClick={() => setRemoving(s)}>
          Remove
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sticky messages</CardTitle>
        <CardDescription>
          A staff message the bot keeps at the bottom of a channel — it deletes its previous copy and re-posts
          whenever members post, at most once per cooldown. Create or replace one in Discord with{' '}
          <code className="text-xs">/sticky set</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataTable
          columns={columns}
          rows={data}
          rowKey={(s) => s.id}
          loading={isLoading}
          error={error}
          onRetry={() => refetch()}
          emptyTitle="No sticky messages"
          emptyDescription="Run /sticky set in the channel you want (optionally with content: and cooldown:) to add one."
        />
        <p className="text-xs text-muted-foreground">
          Removing here stops the re-posts and deletes the record; the last posted copy stays in Discord —
          delete it there or run <code>/sticky remove</code> in the channel to clean it up too.
        </p>
      </CardContent>

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this sticky message?"
        description={
          removing
            ? `The bot will stop re-posting in ${channelName(removing.channelId) ? `#${channelName(removing.channelId)}` : 'this channel'}. Its last posted copy stays until you delete it in Discord (or run /sticky remove there).`
            : undefined
        }
        confirmLabel="Remove sticky"
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={handleConfirmRemove}
      />
    </Card>
  );
}
