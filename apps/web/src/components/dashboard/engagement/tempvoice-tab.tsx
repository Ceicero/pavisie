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
  useToast,
} from '@pavisie/ui';
import type { EngagementConfigDto } from '@pavisie/types/engagement';
import { useEngagementConfig, useUpdateEngagementConfig } from '@/lib/dashboard/engagement-queries';
import { DiscordChannelSelect } from '../discord-selects';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';
import { MultiChannelPicker } from './multi-channel-picker';

const VOICE_CHANNEL_TYPE = 2;

export function TempVoiceTab({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useEngagementConfig(guildId);
  const update = useUpdateEngagementConfig(guildId);
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<EngagementConfigDto['tempVoice'] | null>(null);

  React.useEffect(() => {
    if (data) setDraft(data.tempVoice);
  }, [data]);

  function set<K extends keyof EngagementConfigDto['tempVoice']>(
    key: K,
    value: EngagementConfigDto['tempVoice'][K],
  ) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleSave() {
    if (!draft) return;
    update.mutate(
      { tempVoice: draft },
      {
        onSuccess: () => toast({ title: 'Temp voice settings saved', variant: 'success' }),
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

  const dirty = data ? JSON.stringify(draft) !== JSON.stringify(data.tempVoice) : false;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Temporary voice channels</CardTitle>
        <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {draft.hubChannelIds.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
            Add at least one hub (&quot;join to create&quot;) voice channel below to turn this feature on.
          </p>
        ) : null}

        <FormField
          label="Hub channels"
          hint="Members who join one of these voice channels get their own temporary channel."
        >
          <MultiChannelPicker
            guildId={guildId}
            value={draft.hubChannelIds}
            onChange={(v) => set('hubChannelIds', v)}
            filterType={VOICE_CHANNEL_TYPE}
          />
        </FormField>

        <FormField
          label="Category"
          hint="New channels are created under this category. Leave empty to use the hub's own category."
        >
          <CategoryPicker guildId={guildId} value={draft.categoryId} onChange={(v) => set('categoryId', v)} />
        </FormField>

        <FormField label="Name template" hint="{user} is replaced with the creator's display name.">
          <Input
            value={draft.nameTemplate}
            onChange={(e) => set('nameTemplate', e.target.value)}
            maxLength={100}
          />
        </FormField>

        <FormField
          label="Default user limit"
          hint="0 = no limit. The channel owner can change this per-channel with /tempvoice limit."
        >
          <Input
            type="number"
            min={0}
            max={99}
            value={draft.userLimit}
            onChange={(e) => set('userLimit', Number(e.target.value))}
            className="w-32"
          />
        </FormField>
      </CardContent>
    </Card>
  );
}

/** Category picker — lists only category channels (Discord rejects a non-category `parent`). */
function CategoryPicker({
  guildId,
  value,
  onChange,
}: {
  guildId: string;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <DiscordChannelSelect
      guildId={guildId}
      value={value}
      onChange={onChange}
      placeholder="Same as hub's category"
      kinds={['category']}
    />
  );
}
