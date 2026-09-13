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
import type { EngagementConfigDto, ReputationLeaderboardEntryDto } from '@pavisie/types/engagement';
import {
  useEngagementConfig,
  useRepLeaderboard,
  useUpdateEngagementConfig,
} from '@/lib/dashboard/engagement-queries';
import { DataTable, type DataTableColumn } from '../data-table';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';

export function ReputationTab({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useEngagementConfig(guildId);
  const update = useUpdateEngagementConfig(guildId);
  const leaderboard = useRepLeaderboard(guildId);
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<EngagementConfigDto['rep'] | null>(null);

  React.useEffect(() => {
    if (data) setDraft(data.rep);
  }, [data]);

  function set<K extends keyof EngagementConfigDto['rep']>(key: K, value: EngagementConfigDto['rep'][K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleSave() {
    if (!draft) return;
    update.mutate(
      { rep: draft },
      {
        onSuccess: () => toast({ title: 'Reputation settings saved', variant: 'success' }),
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
  if (isLoading || !draft) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const dirty = data ? JSON.stringify(draft) !== JSON.stringify(data.rep) : false;

  const columns: DataTableColumn<ReputationLeaderboardEntryDto>[] = [
    { key: 'userId', header: 'User ID', render: (r) => <code className="text-xs">{r.userId}</code> },
    { key: 'total', header: 'Reputation', render: (r) => r.total.toLocaleString() },
    { key: 'eventCount', header: 'Times thanked', render: (r) => r.eventCount.toLocaleString() },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Reputation settings</CardTitle>
          <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Reputation enabled</p>
              <p className="text-xs text-muted-foreground">
                Lets members thank each other with {'`/rep give`'}.
              </p>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => set('enabled', v)}
              disabled={update.isPending}
            />
          </div>
          <FormField
            label="Cooldown (hours)"
            hint="How often each member can give reputation. Also caps how often the same member can be thanked by them."
          >
            <Input
              type="number"
              min={1}
              max={720}
              value={draft.cooldownHours}
              onChange={(e) => set('cooldownHours', Number(e.target.value))}
              className="w-40"
            />
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Leaderboard</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={leaderboard.data?.items}
            rowKey={(r) => r.userId}
            loading={leaderboard.isLoading}
            error={leaderboard.error}
            onRetry={() => leaderboard.refetch()}
            emptyTitle="Nobody has received reputation yet"
          />
        </CardContent>
      </Card>
    </div>
  );
}
