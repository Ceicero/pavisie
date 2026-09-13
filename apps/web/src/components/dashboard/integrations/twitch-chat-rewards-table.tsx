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
import type { TwitchChatRewardDto } from '@pavisie/types/integrations';
import { useDeleteTwitchChatReward, useTwitchChatRewards } from '@/lib/dashboard/integrations-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '../confirm-dialog';
import { ErrorState } from '../error-state';
import { TwitchChatRewardDialog } from './twitch-chat-reward-dialog';

/** Max rewards per channel — mirrors `TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL` in
 * `apps/api/src/lib/integrations/twitch-chat-schemas.ts`. Client-side only; the server enforces this. */
const MAX_REWARDS_PER_CHANNEL = 25;

export interface TwitchChatRewardsTableProps {
  guildId: string;
  channelId: string;
}

export function TwitchChatRewardsTable({ guildId, channelId }: TwitchChatRewardsTableProps) {
  const { data, isLoading, error, refetch } = useTwitchChatRewards(guildId, channelId);
  const del = useDeleteTwitchChatReward(guildId);
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TwitchChatRewardDto | null>(null);
  const [deleting, setDeleting] = React.useState<TwitchChatRewardDto | null>(null);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(reward: TwitchChatRewardDto) {
    setEditing(reward);
    setDialogOpen(true);
  }

  function confirmDelete() {
    if (!deleting) return;
    del.mutate(
      { rewardId: deleting.id, channelId },
      {
        onSuccess: () => {
          toast({ title: `Deleted reward "${deleting.rewardTitle}"`, variant: 'success' });
          setDeleting(null);
        },
        onError: (err) =>
          toast({
            title: 'Could not delete the reward',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  const atLimit = (data?.length ?? 0) >= MAX_REWARDS_PER_CHANNEL;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Channel-point rewards</p>
        <Button
          size="sm"
          variant="outline"
          onClick={openCreate}
          disabled={atLimit}
          title={atLimit ? `Limit of ${MAX_REWARDS_PER_CHANNEL} rewards reached` : undefined}
        >
          Add reward
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
          title="No rewards yet"
          description="Create a channel-point reward to trigger actions when viewers redeem it: play a sound, read text-to-speech, post to chat, or send to Discord."
        />
      ) : null}

      {data && data.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Cooldown</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((reward) => (
              <TableRow key={reward.id}>
                <TableCell className="font-medium">{reward.rewardTitle}</TableCell>
                <TableCell className="text-xs text-muted-foreground capitalize">{reward.action}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {reward.cooldownSeconds}s
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {reward.enabled ? 'Yes' : 'No'}
                </TableCell>
                <TableCell className="space-x-1 whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(reward)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(reward)}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      <TwitchChatRewardDialog
        guildId={guildId}
        channelId={channelId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        reward={editing}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete reward "${deleting?.rewardTitle}"?`}
        description="This can't be undone."
        variant="destructive"
        confirmLabel="Delete"
        loading={del.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
