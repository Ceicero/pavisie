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
import type { TwitchChatRewardsBackend } from '@/lib/dashboard/twitch-chat-backend';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '../confirm-dialog';
import { ErrorState } from '../error-state';
import type { DiscordChannelSelectComponent } from '../discord-selects';
import { TwitchChatRewardDialog } from './twitch-chat-reward-dialog';

/** Max rewards per channel — mirrors `TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL` in
 * `apps/api/src/lib/integrations/twitch-chat-schemas.ts`. Client-side only; the server enforces this. */
const MAX_REWARDS_PER_CHANNEL = 25;

export interface TwitchChatRewardsTableProps {
  /** Where rewards are read/written (the creator dashboard's routes). */
  backend: TwitchChatRewardsBackend;
  /** The channel picker for a Discord server the streamer connected and verified; enables "Send to Discord". Without
   * it that action is not offered, and existing Discord-post rewards are shown read-only. */
  discordChannelSelect?: DiscordChannelSelectComponent;
  channelId: string;
  /** The per-channel cap (the API reports it; falls back to the built-in default). */
  maxRewards?: number;
}

export function TwitchChatRewardsTable({
  backend,
  discordChannelSelect,
  channelId,
  maxRewards = MAX_REWARDS_PER_CHANNEL,
}: TwitchChatRewardsTableProps) {
  const { data, isLoading, error, refetch } = backend.useList();
  const del = backend.useRemove();
  const discordAvailable = Boolean(discordChannelSelect);
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

  const atLimit = (data?.length ?? 0) >= maxRewards;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Channel-point rewards</p>
        <Button
          size="sm"
          variant="outline"
          onClick={openCreate}
          disabled={atLimit}
          title={atLimit ? `Limit of ${maxRewards} rewards reached` : undefined}
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
          description={
            discordAvailable
              ? 'Create a channel-point reward to trigger actions when viewers redeem it: play a sound, read text-to-speech, post to chat, or send to Discord.'
              : 'Create a channel-point reward to trigger actions when viewers redeem it: play a sound, read text-to-speech, or post to chat.'
          }
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
                  {reward.action === 'discord' && !discordAvailable ? (
                    <span className="text-xs text-muted-foreground">Connect your Discord server to edit</span>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => openEdit(reward)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(reward)}>
                        Delete
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      <TwitchChatRewardDialog
        backend={backend}
        discordChannelSelect={discordChannelSelect}
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
