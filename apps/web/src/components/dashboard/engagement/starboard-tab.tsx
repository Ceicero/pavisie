'use client';

import * as React from 'react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  Input,
  Skeleton,
  Switch,
  useToast,
} from '@pavisie/ui';
import type { EngagementConfigDto } from '@pavisie/types/engagement';
import { useEngagementConfig, useUpdateEngagementConfig } from '@/lib/dashboard/engagement-queries';
import { DiscordChannelSelect } from '../discord-selects';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';

export function StarboardTab({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useEngagementConfig(guildId);
  const update = useUpdateEngagementConfig(guildId);
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<EngagementConfigDto['starboard'] | null>(null);

  React.useEffect(() => {
    if (data) setDraft(data.starboard);
  }, [data]);

  function set<K extends keyof EngagementConfigDto['starboard']>(
    key: K,
    value: EngagementConfigDto['starboard'][K],
  ) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleSave() {
    if (!draft) return;
    update.mutate(
      { starboard: draft },
      {
        onSuccess: () => toast({ title: 'Starboard settings saved', variant: 'success' }),
        onError: (err) =>
          toast({
            title: 'Could not save',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading || !draft) return <Skeleton className="h-64 w-full" />;

  const dirty = data ? JSON.stringify(draft) !== JSON.stringify(data.starboard) : false;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Starboard settings</CardTitle>
        <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {!draft.channelId ? (
          <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
            The starboard is off until a channel is set below.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Starboard channel"
            hint="Starred messages are posted here. Clear to disable the starboard."
          >
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.channelId}
              onChange={(v) => set('channelId', v)}
              placeholder="Disabled"
            />
          </FormField>
          <FormField label="Emoji" hint="A unicode emoji, or a custom emoji like <:name:id>.">
            <Input value={draft.emoji} onChange={(e) => set('emoji', e.target.value)} className="w-32" />
          </FormField>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Threshold" hint="Stars required before a message is posted.">
            <Input
              type="number"
              min={1}
              max={1000}
              value={draft.threshold}
              onChange={(e) => set('threshold', Number(e.target.value))}
              className="w-32"
            />
          </FormField>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium">Ignore self-stars</p>
            <p className="text-xs text-muted-foreground">
              Authors can&apos;t star their own message to boost it toward the threshold.
            </p>
          </div>
          <Switch
            checked={draft.ignoreSelfStar}
            onCheckedChange={(v) => set('ignoreSelfStar', v)}
            disabled={update.isPending}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
          <div>
            <p className="text-sm font-medium">Allow NSFW channels</p>
            <p className="text-xs text-muted-foreground">
              Off by default — messages from NSFW channels are skipped.
            </p>
          </div>
          <Switch
            checked={draft.allowNsfw}
            onCheckedChange={(v) => set('allowNsfw', v)}
            disabled={update.isPending}
          />
        </div>
      </CardContent>
    </Card>
  );
}
