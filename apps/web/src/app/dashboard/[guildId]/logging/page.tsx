'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import type { LoggingConfigDto } from '@pavisie/types/logging';
import {
  Button,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@pavisie/ui';
import { useLoggingSettings, useUpdateLoggingSettings } from '@/lib/dashboard/logging-queries';
import { ErrorState } from '@/components/dashboard/error-state';
import { ChannelMapTable } from '@/components/dashboard/logging/channel-map-table';
import { RedactionEditor } from '@/components/dashboard/logging/redaction-editor';
import { LogSearch } from '@/components/dashboard/logging/log-search';
import { ApiClientError } from '@/lib/dashboard/api';

export default function LoggingPage() {
  const { guildId } = useParams<{ guildId: string }>();
  const { data, isLoading, error, refetch } = useLoggingSettings(guildId);
  const update = useUpdateLoggingSettings(guildId);
  const { toast } = useToast();

  const [draft, setDraft] = React.useState<LoggingConfigDto | null>(null);

  React.useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  function handleSave() {
    if (!draft) return;
    update.mutate(draft, {
      onSuccess: (saved) => {
        setDraft(saved);
        toast({ title: 'Logging settings saved', variant: 'success' });
      },
      onError: (err) =>
        toast({
          title: 'Could not save logging settings',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;

  if (isLoading || !draft) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  const dirty = data ? JSON.stringify(draft) !== JSON.stringify(data) : false;

  return (
    <div className="space-y-6 pb-24">
      <PageHeader
        title="Logging"
        description="Route member, message, role, channel, moderation, voice, and platform events to log channels, with redaction, retention, and a searchable audit log."
        actions={
          <Button onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        }
      />

      <Tabs defaultValue="channels">
        <TabsList>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="redaction">Redaction</TabsTrigger>
          <TabsTrigger value="search">Search</TabsTrigger>
        </TabsList>

        <TabsContent value="channels">
          <ChannelMapTable guildId={guildId} draft={draft} onChange={setDraft} disabled={update.isPending} />
        </TabsContent>

        <TabsContent value="redaction">
          <RedactionEditor guildId={guildId} draft={draft} onChange={setDraft} disabled={update.isPending} />
        </TabsContent>

        <TabsContent value="search">
          <LogSearch guildId={guildId} storeEventsEnabled={data?.storeEvents ?? false} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
