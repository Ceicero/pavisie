'use client';

import * as React from 'react';
import { Hash, Megaphone, X } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ChannelPicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatCard,
  Switch,
  Textarea,
  useToast,
} from '@pavisie/ui';
import { ApiClientError } from '@/lib/dashboard/api';
import { useChannelAutomationStats } from '@/lib/dashboard/community-queries';
import { useGuildChannels, usePluginConfig, useUpdatePluginConfig } from '@/lib/dashboard/queries';
import { DataTable, type DataTableColumn } from '../data-table';
import { ErrorState } from '../error-state';

// Discord channel types (discord-api-types `ChannelType`).
const GUILD_TEXT = 0;
const GUILD_ANNOUNCEMENT = 5;
const MAX_ENTRIES = 25;
const DEFAULT_TEMPLATE = '{user} — {date}';

const ARCHIVE_OPTIONS: { value: AutoThreadRule['archiveMinutes']; label: string }[] = [
  { value: 60, label: '1 hour' },
  { value: 1440, label: '1 day' },
  { value: 4320, label: '3 days' },
  { value: 10080, label: '1 week' },
];

/** Mirrors the `autoPublish` / `autoThreads` keys of `packages/plugins/src/community/manifest.ts` (hand-kept in sync; the dashboard doesn't depend on `@pavisie/plugins`). Other community keys pass through untouched. */
export interface AutoThreadRule {
  channelId: string;
  nameTemplate: string;
  archiveMinutes: 60 | 1440 | 4320 | 10080;
  requireAttachment: boolean;
  starterMessage: string | null;
}

export interface CommunityChannelAutomationConfig {
  autoPublish: { channelIds: string[]; includeBots: boolean };
  autoThreads: AutoThreadRule[];
}

type Draft = CommunityChannelAutomationConfig;

function emptyRule(channelId = ''): AutoThreadRule {
  return {
    channelId,
    nameTemplate: DEFAULT_TEMPLATE,
    archiveMinutes: 1440,
    requireAttachment: false,
    starterMessage: null,
  };
}

function normalize(config: Partial<CommunityChannelAutomationConfig> | undefined): Draft {
  return {
    autoPublish: {
      channelIds: config?.autoPublish?.channelIds ?? [],
      includeBots: config?.autoPublish?.includeBots ?? false,
    },
    autoThreads: config?.autoThreads ?? [],
  };
}

/** Channel automations card of the community page's Channels tab (`channels-tab.tsx`) — auto-publish (announcement crossposting) and auto-threads ("one thread per post"), both stored in the community plugin config. */
export function ChannelAutomationsCard({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = usePluginConfig<CommunityChannelAutomationConfig>(
    guildId,
    'community',
  );
  const update = useUpdatePluginConfig<CommunityChannelAutomationConfig>(guildId, 'community');
  const stats = useChannelAutomationStats(guildId);
  const channels = useGuildChannels(guildId);
  const { toast } = useToast();

  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [editing, setEditing] = React.useState<{ rule: AutoThreadRule; isNew: boolean } | null>(null);

  React.useEffect(() => {
    if (data) setDraft(normalize(data.config));
  }, [data]);

  const channelName = React.useCallback(
    (id: string) => channels.data?.find((c) => c.id === id)?.name ?? id,
    [channels.data],
  );

  function handleSave() {
    if (!draft) return;
    update.mutate(
      { autoPublish: draft.autoPublish, autoThreads: draft.autoThreads },
      {
        onSuccess: () => toast({ title: 'Channel automations saved', variant: 'success' }),
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
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const saved = normalize(data?.config);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const announcementChannels = (channels.data ?? []).filter((c) => c.type === GUILD_ANNOUNCEMENT);
  const threadableChannels = (channels.data ?? []).filter(
    (c) => c.type === GUILD_TEXT || c.type === GUILD_ANNOUNCEMENT,
  );

  // ---- auto-publish helpers ------------------------------------------------
  const publishIds = draft.autoPublish.channelIds;
  function addPublishChannel(id: string | null) {
    if (!id || publishIds.includes(id) || publishIds.length >= MAX_ENTRIES) return;
    setDraft({ ...draft!, autoPublish: { ...draft!.autoPublish, channelIds: [...publishIds, id] } });
  }
  function removePublishChannel(id: string) {
    setDraft({
      ...draft!,
      autoPublish: { ...draft!.autoPublish, channelIds: publishIds.filter((v) => v !== id) },
    });
  }

  // ---- auto-thread helpers -------------------------------------------------
  function upsertRule(rule: AutoThreadRule) {
    const exists = draft!.autoThreads.some((r) => r.channelId === rule.channelId);
    setDraft({
      ...draft!,
      autoThreads: exists
        ? draft!.autoThreads.map((r) => (r.channelId === rule.channelId ? rule : r))
        : [...draft!.autoThreads, rule],
    });
  }
  function removeRule(channelId: string) {
    setDraft({ ...draft!, autoThreads: draft!.autoThreads.filter((r) => r.channelId !== channelId) });
  }

  const ruleColumns: DataTableColumn<AutoThreadRule>[] = [
    {
      key: 'channel',
      header: 'Channel',
      render: (r) => (
        <span className="flex items-center gap-1.5">
          <Hash className="h-3.5 w-3.5 text-muted-foreground" />
          {channelName(r.channelId)}
        </span>
      ),
    },
    {
      key: 'template',
      header: 'Thread name',
      render: (r) => <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.nameTemplate}</code>,
    },
    {
      key: 'archive',
      header: 'Auto-archive',
      render: (r) =>
        ARCHIVE_OPTIONS.find((o) => o.value === r.archiveMinutes)?.label ?? `${r.archiveMinutes} min`,
    },
    {
      key: 'flags',
      header: 'Options',
      render: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.requireAttachment ? <Badge variant="secondary">Attachments only</Badge> : null}
          {r.starterMessage ? <Badge variant="outline">Starter message</Badge> : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (
        <span className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing({ rule: r, isNew: false })}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => removeRule(r.channelId)}>
            Remove
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Button onClick={handleSave} disabled={!dirty || update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Auto-publish */}
      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4" /> Auto-publish
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Every new message in the announcement channels below is published to follower servers
            automatically, so staff never have to click &quot;Publish&quot;. Message content is never read.
          </p>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              <FormField
                label="Announcement channels"
                hint={`Up to ${MAX_ENTRIES}. Only announcement channels can be published.`}
              >
                <div className="space-y-2">
                  {publishIds.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {publishIds.map((id) => (
                        <Badge key={id} variant="secondary" className="gap-1 pr-1">
                          <Megaphone className="h-3 w-3" />
                          {channelName(id)}
                          <button
                            type="button"
                            aria-label={`Remove ${channelName(id)}`}
                            onClick={() => removePublishChannel(id)}
                            disabled={update.isPending}
                            className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No channels yet.</p>
                  )}
                  {channels.isError ? (
                    <Input
                      placeholder="Announcement channel ID — press Enter to add"
                      disabled={update.isPending || publishIds.length >= MAX_ENTRIES}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        const value = e.currentTarget.value.trim();
                        if (value) {
                          addPublishChannel(value);
                          e.currentTarget.value = '';
                        }
                      }}
                    />
                  ) : (
                    <ChannelPicker
                      options={announcementChannels.filter((c) => !publishIds.includes(c.id))}
                      value={null}
                      onChange={addPublishChannel}
                      placeholder={
                        announcementChannels.length === 0
                          ? 'No announcement channels in this server'
                          : 'Add an announcement channel…'
                      }
                      allowNone={false}
                      disabled={update.isPending || channels.isLoading || publishIds.length >= MAX_ENTRIES}
                    />
                  )}
                </div>
              </FormField>

              <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
                <div>
                  <p className="text-sm font-medium">Also publish other bots and webhooks</p>
                  <p className="text-xs text-muted-foreground">
                    Off by default: only members&apos; messages and Pavisie&apos;s own posts are published.
                  </p>
                </div>
                <Switch
                  checked={draft.autoPublish.includeBots}
                  onCheckedChange={(v) =>
                    setDraft({ ...draft, autoPublish: { ...draft.autoPublish, includeBots: v } })
                  }
                  disabled={update.isPending}
                />
              </div>
            </div>

            <StatCard
              label="Published today"
              value={stats.isLoading ? '—' : (stats.data?.autoPublishToday ?? 0)}
              hint="Counted per UTC day"
              icon={<Megaphone />}
            />
          </div>

          <Alert>
            <AlertTitle>Good to know</AlertTitle>
            <AlertDescription>
              Discord allows at most <strong>10 publishes per hour per channel</strong>; past that, messages
              stay unpublished until the next hour (you can still publish them by hand). Publishing other
              members&apos; messages needs the bot to have <strong>Manage Messages</strong> in that channel —
              without it, only Pavisie&apos;s own messages are published and a warning is logged once per
              hour.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Auto-threads */}
      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Hash className="h-4 w-4" /> Auto-threads
            </span>
            <Button
              size="sm"
              onClick={() => setEditing({ rule: emptyRule(), isNew: true })}
              disabled={update.isPending || draft.autoThreads.length >= MAX_ENTRIES}
            >
              Add rule
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            One thread per post — great for showcase, clip, and LFG channels. Bot posts are never threaded.
            Templates support <code>{'{user}'}</code>, <code>{'{user.tag}'}</code>, <code>{'{server}'}</code>{' '}
            and <code>{'{date}'}</code>.
          </p>
          <DataTable
            columns={ruleColumns}
            rows={draft.autoThreads}
            rowKey={(r) => r.channelId}
            emptyTitle="No auto-thread rules"
            emptyDescription="Add a rule to give every post in a channel its own thread."
          />
        </CardContent>
      </Card>

      <RuleDialog
        key={editing ? `${editing.rule.channelId}:${editing.isNew}` : 'closed'}
        open={Boolean(editing)}
        initial={editing?.rule ?? null}
        isNew={editing?.isNew ?? false}
        channels={threadableChannels}
        channelsUnavailable={channels.isError}
        takenChannelIds={draft.autoThreads.map((r) => r.channelId)}
        onClose={() => setEditing(null)}
        onSave={(rule) => {
          upsertRule(rule);
          setEditing(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rule dialog
// ---------------------------------------------------------------------------

interface RuleDialogProps {
  open: boolean;
  initial: AutoThreadRule | null;
  isNew: boolean;
  channels: { id: string; name: string; type?: number }[];
  channelsUnavailable: boolean;
  takenChannelIds: string[];
  onClose: () => void;
  onSave: (rule: AutoThreadRule) => void;
}

function RuleDialog({
  open,
  initial,
  isNew,
  channels,
  channelsUnavailable,
  takenChannelIds,
  onClose,
  onSave,
}: RuleDialogProps) {
  const [rule, setRule] = React.useState<AutoThreadRule>(initial ?? emptyRule());
  const [starter, setStarter] = React.useState(initial?.starterMessage ?? '');

  const templateTooLong = rule.nameTemplate.length > 100;
  const templateEmpty = rule.nameTemplate.trim().length === 0;
  const starterTooLong = starter.length > 300;
  const canSave = rule.channelId.trim().length > 0 && !templateEmpty && !templateTooLong && !starterTooLong;

  const pickable = channels.filter((c) => c.id === rule.channelId || !takenChannelIds.includes(c.id));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? 'New auto-thread rule' : 'Edit auto-thread rule'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <FormField label="Channel" hint="Text or announcement channel." required>
            {channelsUnavailable ? (
              <Input
                value={rule.channelId}
                placeholder="Channel ID"
                disabled={!isNew}
                onChange={(e) => setRule({ ...rule, channelId: e.target.value.trim() })}
              />
            ) : (
              <ChannelPicker
                options={pickable}
                value={rule.channelId || null}
                onChange={(id) => setRule({ ...rule, channelId: id ?? '' })}
                allowNone={false}
                placeholder="Select a channel"
                disabled={!isNew}
              />
            )}
          </FormField>
          <FormField
            label="Thread name template"
            hint="Max 100 characters after rendering; longer names are trimmed."
            error={
              templateTooLong ? 'Keep it under 100 characters.' : templateEmpty ? 'Required.' : undefined
            }
            required
          >
            <Input
              value={rule.nameTemplate}
              onChange={(e) => setRule({ ...rule, nameTemplate: e.target.value })}
              placeholder={DEFAULT_TEMPLATE}
              maxLength={100}
            />
          </FormField>
          <FormField label="Auto-archive after">
            <Select
              value={String(rule.archiveMinutes)}
              onValueChange={(v) =>
                setRule({ ...rule, archiveMinutes: Number(v) as AutoThreadRule['archiveMinutes'] })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ARCHIVE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={String(o.value)}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Attachments or embeds only</p>
              <p className="text-xs text-muted-foreground">
                Skip text-only posts — for media and showcase channels.
              </p>
            </div>
            <Switch
              checked={rule.requireAttachment}
              onCheckedChange={(v) => setRule({ ...rule, requireAttachment: v })}
            />
          </div>
          <FormField
            label="Starter message (optional)"
            hint="Posted by the bot inside each new thread. Same tokens as the name. Max 300 characters."
            error={starterTooLong ? 'Keep it under 300 characters.' : undefined}
          >
            <Textarea
              value={starter}
              onChange={(e) => setStarter(e.target.value)}
              rows={2}
              maxLength={300}
              placeholder="e.g. Discuss {user}'s post here — keep the main channel tidy!"
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            onClick={() =>
              onSave({
                ...rule,
                channelId: rule.channelId.trim(),
                nameTemplate: rule.nameTemplate.trim(),
                starterMessage: starter.trim() ? starter.trim() : null,
              })
            }
          >
            {isNew ? 'Add rule' : 'Update rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
