'use client';

import * as React from 'react';
import { Trash2 } from 'lucide-react';
import { Button, EmptyState, IconButton, Input, Skeleton, useToast } from '@pavisie/ui';
import { useCreateLevelReward, useDeleteLevelReward, useLevelRewards } from '@/lib/dashboard/engagement-queries';
import { DiscordRoleSelect } from '../discord-selects';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';

export interface RewardsEditorProps {
  guildId: string;
}

/** Level → role reward list, with an inline add form and per-row delete. */
export function RewardsEditor({ guildId }: RewardsEditorProps) {
  const { data: rewards, isLoading, error, refetch } = useLevelRewards(guildId);
  const create = useCreateLevelReward(guildId);
  const remove = useDeleteLevelReward(guildId);
  const { toast } = useToast();

  const [level, setLevel] = React.useState('');
  const [roleId, setRoleId] = React.useState<string | null>(null);

  function handleAdd() {
    const levelNum = Number(level);
    if (!Number.isInteger(levelNum) || levelNum < 1 || !roleId) {
      toast({ title: 'Pick a level and a role first', variant: 'destructive' });
      return;
    }
    create.mutate(
      { level: levelNum, roleId },
      {
        onSuccess: () => {
          setLevel('');
          setRoleId(null);
        },
        onError: (err) =>
          toast({
            title: 'Could not add reward',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="w-28 space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="reward-level">
            Level
          </label>
          <Input
            id="reward-level"
            type="number"
            min={1}
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            placeholder="10"
          />
        </div>
        <div className="flex-1 space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Role</label>
          <DiscordRoleSelect
            guildId={guildId}
            value={roleId}
            onChange={setRoleId}
            placeholder="Role to grant"
          />
        </div>
        <Button onClick={handleAdd} disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add reward'}
        </Button>
      </div>

      {error ? <ErrorState error={error} onRetry={() => refetch()} /> : null}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : null}

      {!isLoading && !error && (!rewards || rewards.length === 0) ? (
        <EmptyState
          title="No level rewards yet"
          description="Members earn a role automatically when they reach a configured level."
        />
      ) : null}

      {rewards && rewards.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rewards.map((reward) => (
            <li key={reward.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-sm">
                Level <span className="font-medium tabular-nums">{reward.level}</span> → role{' '}
                <code className="text-xs text-muted-foreground">{reward.roleId}</code>
              </span>
              <IconButton
                label="Remove reward"
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(reward.id, {
                    onError: (err) =>
                      toast({
                        title: 'Could not remove reward',
                        description: err instanceof ApiClientError ? err.message : 'Please try again.',
                        variant: 'destructive',
                      }),
                  })
                }
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
