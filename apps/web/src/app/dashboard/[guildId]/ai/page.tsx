'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useToast,
} from '@pavisie/ui';
import { useAiSettings, useAiUsage } from '@/lib/dashboard/ai-queries';
import { usePlugins, useTogglePlugin } from '@/lib/dashboard/queries';
import { ErrorState } from '@/components/dashboard/error-state';
import { ApiClientError } from '@/lib/dashboard/api';
import { AiSettingsForm } from '@/components/dashboard/ai/ai-settings-form';
import { MentionChatForm } from '@/components/dashboard/ai/mention-chat-form';
import { UsageChart } from '@/components/dashboard/ai/usage-chart';

const RANGE_OPTIONS = [
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
];

export default function AiPage() {
  const { guildId } = useParams<{ guildId: string }>();
  const [rangeDays, setRangeDays] = React.useState(30);
  const { toast } = useToast();

  const settingsQuery = useAiSettings(guildId);
  const usageQuery = useAiUsage(guildId, rangeDays);
  const pluginsQuery = usePlugins(guildId);
  const togglePlugin = useTogglePlugin(guildId);

  const aiPlugin = pluginsQuery.data?.find((p) => p.id === 'ai');

  function handleOptInToggle(next: boolean) {
    togglePlugin.mutate(
      { pluginId: 'ai', enabled: next },
      {
        onSuccess: () =>
          toast({ title: next ? 'AI assistant enabled' : 'AI assistant disabled', variant: 'success' }),
        onError: (err) =>
          toast({
            title: 'Could not update the plugin',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Assistant"
        description="Optional, opt-in help: /ask, /summarize, /draft, /mod-assist, and mention chat. Disabled by default."
      />

      <Alert>
        <Sparkles className="h-4 w-4" />
        <AlertTitle className="flex flex-wrap items-center gap-2">
          <span>Opt-in feature</span>
          {aiPlugin ? (
            <span className="ml-auto flex items-center gap-2 text-xs font-normal">
              {aiPlugin.enabled ? (
                <Badge variant="success">Enabled</Badge>
              ) : (
                <Badge variant="secondary">Disabled</Badge>
              )}
              <Switch
                checked={aiPlugin.enabled}
                onCheckedChange={handleOptInToggle}
                disabled={togglePlugin.isPending}
                aria-label="Toggle AI assistant"
              />
            </span>
          ) : null}
        </AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            This server's messages are never sent anywhere until an admin turns this on <strong>and</strong>{' '}
            configures a provider + API key below. Every AI response includes the disclosure "AI can be
            inaccurate — verify important information."
          </p>
          <p>
            Content is redacted (mentions, emails, phone numbers, URL paths, and key/token-shaped strings)
            before it reaches the provider. Only token counts are stored — never prompt or response text — and
            the platform does not opt your server into any provider's model training by default.
          </p>
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent>
          {settingsQuery.error ? (
            <ErrorState error={settingsQuery.error} onRetry={() => settingsQuery.refetch()} />
          ) : settingsQuery.isLoading || !settingsQuery.data ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <AiSettingsForm guildId={guildId} settings={settingsQuery.data} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mention chat</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert>
            <Sparkles className="h-4 w-4" />
            <AlertDescription>
              The bot only replies when @mentioned in these channels — never passively, and never just because
              a message replies to it. The mentioning message plus a short window of recent context (redacted)
              go to the same provider configured above; nothing is stored beyond usage counters.
            </AlertDescription>
          </Alert>
          {settingsQuery.error ? (
            <ErrorState error={settingsQuery.error} onRetry={() => settingsQuery.refetch()} />
          ) : settingsQuery.isLoading || !settingsQuery.data ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <MentionChatForm guildId={guildId} settings={settingsQuery.data} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle>Usage</CardTitle>
          <Select value={String(rangeDays)} onValueChange={(v) => setRangeDays(Number(v))}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((r) => (
                <SelectItem key={r.value} value={String(r.value)}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="space-y-4">
          {usageQuery.error ? (
            <ErrorState error={usageQuery.error} onRetry={() => usageQuery.refetch()} />
          ) : usageQuery.isLoading || !usageQuery.data ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Requests" value={usageQuery.data.totalRequests.toLocaleString()} />
                <Stat label="Prompt tokens" value={usageQuery.data.totalPromptTokens.toLocaleString()} />
                <Stat
                  label="Completion tokens"
                  value={usageQuery.data.totalCompletionTokens.toLocaleString()}
                />
                <Stat label="Daily budget" value={usageQuery.data.dailyTokenBudget.toLocaleString()} />
              </div>
              <UsageChart daily={usageQuery.data.daily} dailyTokenBudget={usageQuery.data.dailyTokenBudget} />
              {usageQuery.data.topCommands.length > 0 ? (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Top commands
                  </p>
                  <ul className="space-y-1 text-sm">
                    {usageQuery.data.topCommands.map((c) => (
                      <li
                        key={c.command}
                        className="flex items-center justify-between rounded-md border border-border px-3 py-1.5"
                      >
                        <span className="font-mono">/{c.command}</span>
                        <span className="text-muted-foreground">
                          {c.requests} request{c.requests === 1 ? '' : 's'} · {c.totalTokens.toLocaleString()}{' '}
                          tokens
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
