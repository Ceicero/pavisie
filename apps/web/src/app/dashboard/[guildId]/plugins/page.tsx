'use client';

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { PluginSummary } from '@pavisie/types';
import {
  Button,
  EmptyState,
  PageHeader,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
  useToast,
} from '@pavisie/ui';
import { usePluginConfig, usePlugins, useUpdatePluginConfig } from '@/lib/dashboard/queries';
import { ErrorState } from '@/components/dashboard/error-state';
import { PluginCard } from '@/components/dashboard/plugin-card';
import { JsonSchemaForm } from '@/components/dashboard/json-schema-form';
import { ApiClientError } from '@/lib/dashboard/api';

const CATEGORY_ORDER = ['admin', 'moderation', 'community', 'utility', 'integrations', 'ai', 'media'];
const CATEGORY_LABEL: Record<string, string> = {
  admin: 'Administration',
  moderation: 'Moderation',
  community: 'Community',
  utility: 'Utility',
  integrations: 'Integrations',
  ai: 'AI',
  media: 'Media',
};

export default function PluginsPage() {
  const { guildId } = useParams<{ guildId: string }>();
  const router = useRouter();
  const { data: plugins, isLoading, error, refetch } = usePlugins(guildId);
  const [configuring, setConfiguring] = React.useState<PluginSummary | null>(null);

  // Plugins with a dedicated dashboard page (most non-trivial config shapes: nested objects, arrays of
  // objects, etc.) get routed there instead of the generic auto-form drawer, which is meant for simpler
  // plugins without one.
  function handleConfigure(plugin: PluginSummary) {
    if (plugin.dashboardPath) {
      router.push(plugin.dashboardPath.replace('[guildId]', guildId));
      return;
    }
    setConfiguring(plugin);
  }

  const grouped = React.useMemo(() => {
    const map = new Map<string, PluginSummary[]>();
    for (const plugin of plugins ?? []) {
      const list = map.get(plugin.category) ?? [];
      list.push(plugin);
      map.set(plugin.category, list);
    }
    return [...map.entries()].sort(
      (a, b) =>
        (CATEGORY_ORDER.indexOf(a[0]) === -1 ? 99 : CATEGORY_ORDER.indexOf(a[0])) -
        (CATEGORY_ORDER.indexOf(b[0]) === -1 ? 99 : CATEGORY_ORDER.indexOf(b[0])),
    );
  }, [plugins]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Plugins"
        description="Enable exactly what your server needs. Nothing here runs until you turn it on."
      />

      {error ? <ErrorState error={error} onRetry={() => refetch()} /> : null}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      ) : null}

      {!isLoading && !error && (!plugins || plugins.length === 0) ? (
        <EmptyState
          title="No plugins available"
          description="The plugin registry did not return any plugins."
        />
      ) : null}

      {grouped.map(([category, list]) => (
        <section key={category} className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {CATEGORY_LABEL[category] ?? category}
          </h2>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {list.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                guildId={guildId}
                onConfigure={() => handleConfigure(plugin)}
              />
            ))}
          </div>
        </section>
      ))}

      <Sheet open={configuring !== null} onOpenChange={(open) => !open && setConfiguring(null)}>
        <SheetContent side="right" className="w-full sm:max-w-lg">
          {configuring ? (
            <PluginConfigSheetBody
              guildId={guildId}
              plugin={configuring}
              onClose={() => setConfiguring(null)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function PluginConfigSheetBody({
  guildId,
  plugin,
  onClose,
}: {
  guildId: string;
  plugin: PluginSummary;
  onClose: () => void;
}) {
  const { data, isLoading, error, refetch } = usePluginConfig<Record<string, unknown>>(guildId, plugin.id);
  const update = useUpdatePluginConfig<Record<string, unknown>>(guildId, plugin.id);
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<Record<string, unknown> | null>(null);

  React.useEffect(() => {
    if (data) setDraft(data.config ?? {});
  }, [data]);

  function handleSave() {
    if (!draft) return;
    update.mutate(draft, {
      onSuccess: () => {
        toast({ title: 'Configuration saved', variant: 'success' });
        onClose();
      },
      onError: (err) =>
        toast({
          title: 'Could not save configuration',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>{plugin.name}</SheetTitle>
        <SheetDescription>{plugin.description}</SheetDescription>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto py-4">
        {error ? <ErrorState error={error} onRetry={() => refetch()} /> : null}
        {isLoading || !draft ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : data ? (
          <JsonSchemaForm
            schema={data.schema}
            value={draft}
            onChange={setDraft}
            guildId={guildId}
            disabled={update.isPending}
          />
        ) : null}
      </div>

      <SheetFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!draft || update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </SheetFooter>
    </>
  );
}
