'use client';

import * as React from 'react';
import { Info } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ChannelPicker,
  FormField,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@pavisie/ui';
import { ApiClientError } from '@/lib/dashboard/api';
import { useGuildChannels, usePluginConfig, useUpdatePluginConfig } from '@/lib/dashboard/queries';
import { ErrorState } from '../error-state';

/** Mirrors the stats-channel part of `packages/plugins/src/community/manifest.ts`'s `configSchema` (hand-kept in sync; the dashboard doesn't depend on `@pavisie/plugins`). */
export interface StatsChannelEntry {
  channelId: string;
  template: string;
}

interface CommunityChannelsConfig {
  statsChannels: StatsChannelEntry[];
  statsRefreshMinutes: number;
}

/** Same fixed token set as `packages/plugins/src/community/stats-channels.ts` — `{online}` is deliberately absent (Presence intent). */
const STATS_TOKENS = ['members', 'humans', 'bots', 'boosts', 'roles', 'channels', 'date'] as const;
const MAX_STATS_CHANNELS = 10;
const TEMPLATE_MAX = 90;
// Discord channel types the picker offers for "add existing": 0 = text, 2 = voice, 4 = category.
const STATS_CHANNEL_TYPES = new Set([0, 2, 4]);

/** Returns the unknown `{tokens}` in `template` (empty when it is valid). `{online}` is reported like any other unknown token; the hint below explains why. */
export function unknownTemplateTokens(template: string): string[] {
  const unknown: string[] = [];
  for (const match of template.matchAll(/\{([a-zA-Z_]+)\}/g)) {
    const name = match[1] ?? '';
    if ((STATS_TOKENS as readonly string[]).includes(name) || unknown.includes(name)) continue;
    unknown.push(name);
  }
  return unknown;
}

/** Server-stats counter channels card of the community page's Channels tab (`channels-tab.tsx`, spec CG-05). */
export function StatsChannelsCard({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = usePluginConfig<CommunityChannelsConfig>(guildId, 'community');
  const update = useUpdatePluginConfig<CommunityChannelsConfig>(guildId, 'community');
  const channels = useGuildChannels(guildId);
  const { toast } = useToast();

  const [entries, setEntries] = React.useState<StatsChannelEntry[] | null>(null);
  const [refreshMinutes, setRefreshMinutes] = React.useState<number>(15);
  const [addChannelId, setAddChannelId] = React.useState<string | null>(null);
  const [addTemplate, setAddTemplate] = React.useState('Members: {members}');

  React.useEffect(() => {
    if (data) {
      setEntries(data.config.statsChannels ?? []);
      setRefreshMinutes(data.config.statsRefreshMinutes ?? 15);
    }
  }, [data]);

  const channelName = React.useCallback(
    (id: string) => channels.data?.find((c) => c.id === id)?.name ?? null,
    [channels.data],
  );

  function save(patch: Partial<CommunityChannelsConfig>, successTitle: string) {
    update.mutate(patch, {
      onSuccess: () => toast({ title: successTitle, variant: 'success' }),
      onError: (err) =>
        toast({
          title: 'Could not save',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  function templateProblem(template: string): string | null {
    const trimmed = template.trim();
    if (!trimmed) return 'Template cannot be empty.';
    if (trimmed.length > TEMPLATE_MAX) return `Template must be at most ${TEMPLATE_MAX} characters.`;
    const unknown = unknownTemplateTokens(trimmed);
    if (unknown.length > 0) {
      const list = unknown.map((tk) => `{${tk}}`).join(', ');
      return unknown.some((tk) => tk.toLowerCase() === 'online')
        ? `{online} isn't available (needs the Presence privileged intent, which the bot does not enable). Unknown: ${list}`
        : `Unknown token(s): ${list}`;
    }
    return null;
  }

  function handleAdd() {
    if (!entries || !addChannelId) return;
    if (entries.some((e) => e.channelId === addChannelId)) {
      toast({ title: 'That channel is already a stats channel', variant: 'destructive' });
      return;
    }
    if (entries.length >= MAX_STATS_CHANNELS) {
      toast({ title: `At most ${MAX_STATS_CHANNELS} stats channels per server`, variant: 'destructive' });
      return;
    }
    const problem = templateProblem(addTemplate);
    if (problem) {
      toast({ title: 'Invalid template', description: problem, variant: 'destructive' });
      return;
    }
    const next = [...entries, { channelId: addChannelId, template: addTemplate.trim() }];
    setEntries(next);
    setAddChannelId(null);
    save({ statsChannels: next }, 'Stats channel added');
  }

  function handleTemplateBlur(channelId: string, template: string) {
    if (!entries || !data) return;
    const current = data.config.statsChannels.find((e) => e.channelId === channelId)?.template;
    if (current === template.trim()) return;
    const problem = templateProblem(template);
    if (problem) {
      toast({ title: 'Invalid template', description: problem, variant: 'destructive' });
      // Revert the draft to the saved value.
      setEntries(
        entries.map((e) => (e.channelId === channelId ? { ...e, template: current ?? e.template } : e)),
      );
      return;
    }
    const next = entries.map((e) => (e.channelId === channelId ? { ...e, template: template.trim() } : e));
    setEntries(next);
    save({ statsChannels: next }, 'Template saved');
  }

  function handleRemove(channelId: string) {
    if (!entries) return;
    const next = entries.filter((e) => e.channelId !== channelId);
    setEntries(next);
    save({ statsChannels: next }, 'Stats channel removed (the Discord channel itself was not deleted)');
  }

  function handleIntervalBlur() {
    if (!data) return;
    const minutes = Math.round(refreshMinutes);
    if (!Number.isFinite(minutes) || minutes < 10 || minutes > 1440) {
      toast({ title: 'Interval must be between 10 and 1440 minutes', variant: 'destructive' });
      setRefreshMinutes(data.config.statsRefreshMinutes);
      return;
    }
    if (minutes === data.config.statsRefreshMinutes) return;
    setRefreshMinutes(minutes);
    save({ statsRefreshMinutes: minutes }, 'Refresh interval saved');
  }

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;

  if (isLoading || !entries) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const pickerOptions = (channels.data ?? []).filter((c) => STATS_CHANNEL_TYPES.has(c.type ?? 0));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Server stats channels</CardTitle>
          <CardDescription>
            Locked voice channels (or categories) at the top of the channel list whose names show live server
            counts, e.g. &ldquo;Members: 1,234&rdquo;. New counters are created from Discord with{' '}
            <code className="text-xs">/statschannel create</code>; here you can attach an existing channel,
            edit templates, or detach one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <Info />
            <AlertTitle>Two Discord limits to know</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                <li>
                  Discord allows only <strong>2 channel renames per 10 minutes</strong> per channel, so
                  counters refresh on a schedule (minimum every 10 minutes) rather than instantly on each
                  join/leave.
                </li>
                <li>
                  <strong>&ldquo;Online&rdquo; counts are not offered</strong> — they need the Presence
                  privileged intent, which this bot does not enable.
                </li>
              </ul>
            </AlertDescription>
          </Alert>

          <p className="text-xs text-muted-foreground">
            Tokens: {STATS_TOKENS.map((tk) => `{${tk}}`).join(' ')} — {'{date}'} renders as YYYY-MM-DD in the
            server timezone. Templates are truncated to 100 characters after rendering.
          </p>

          {entries.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              No stats channels yet. Run <code className="text-xs">/statschannel create</code> in Discord to
              create a counter, or attach an existing channel below.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Channel</TableHead>
                    <TableHead>Template</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => (
                    <TableRow key={entry.channelId}>
                      <TableCell>
                        {channelName(entry.channelId) ? (
                          <span>{channelName(entry.channelId)}</span>
                        ) : (
                          <code className="text-xs">{entry.channelId}</code>
                        )}
                      </TableCell>
                      <TableCell>
                        <Input
                          value={entry.template}
                          maxLength={TEMPLATE_MAX}
                          disabled={update.isPending}
                          onChange={(e) =>
                            setEntries(
                              entries.map((x) =>
                                x.channelId === entry.channelId ? { ...x, template: e.target.value } : x,
                              ),
                            )
                          }
                          onBlur={(e) => handleTemplateBlur(entry.channelId, e.target.value)}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={update.isPending}
                          onClick={() => handleRemove(entry.channelId)}
                        >
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <FormField label="Attach existing channel" hint="Voice, category, or text channel to rename.">
              {channels.isError ? (
                <Input
                  value={addChannelId ?? ''}
                  placeholder="Channel ID"
                  onChange={(e) => setAddChannelId(e.target.value || null)}
                />
              ) : (
                <ChannelPicker
                  options={pickerOptions}
                  value={addChannelId}
                  onChange={setAddChannelId}
                  allowNone={false}
                  disabled={channels.isLoading || update.isPending}
                />
              )}
            </FormField>
            <FormField label="Template">
              <Input
                value={addTemplate}
                maxLength={TEMPLATE_MAX}
                disabled={update.isPending}
                onChange={(e) => setAddTemplate(e.target.value)}
              />
            </FormField>
            <Button
              onClick={handleAdd}
              disabled={!addChannelId || update.isPending || entries.length >= MAX_STATS_CHANNELS}
            >
              Add
            </Button>
          </div>

          <FormField
            label="Auto-refresh interval (minutes)"
            hint="10-1440. Each refresh renames every stats channel whose count changed."
          >
            <Input
              type="number"
              className="max-w-[10rem]"
              min={10}
              max={1440}
              value={refreshMinutes}
              disabled={update.isPending}
              onChange={(e) => setRefreshMinutes(Number(e.target.value))}
              onBlur={handleIntervalBlur}
            />
          </FormField>
        </CardContent>
      </Card>
    </div>
  );
}
