'use client';

import * as React from 'react';
import { Trophy } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  Input,
  Pagination,
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
import type { EngagementConfigDto, LevelProfileDto } from '@pavisie/types/engagement';
import {
  useEngagementConfig,
  useLevelLeaderboard,
  useUpdateEngagementConfig,
} from '@/lib/dashboard/engagement-queries';
import { DataTable, type DataTableColumn } from '../data-table';
import { DiscordChannelSelect } from '../discord-selects';
import { MultiRolePicker } from '../multi-role-picker';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';
import { XpAdjustDialog } from './xp-adjust-dialog';
import { RewardsEditor } from './rewards-editor';
import { MultiChannelPicker } from './multi-channel-picker';

const LEVEL_UP_CHANNEL_MODES = [
  { value: 'current', label: 'Wherever the message was sent' },
  { value: 'dm', label: 'Direct message' },
  { value: 'none', label: "Don't announce" },
  { value: 'channel', label: 'Specific channel' },
];

export function LevelingTab({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useEngagementConfig(guildId);
  const update = useUpdateEngagementConfig(guildId);
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<EngagementConfigDto['leveling'] | null>(null);
  const [xpDialogOpen, setXpDialogOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [cursor, setCursor] = React.useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (data) setDraft(data.leveling);
  }, [data]);

  const leaderboard = useLevelLeaderboard(guildId, cursor);

  function set<K extends keyof EngagementConfigDto['leveling']>(
    key: K,
    value: EngagementConfigDto['leveling'][K],
  ) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleSave() {
    if (!draft) return;
    update.mutate(
      { leveling: draft },
      {
        onSuccess: () => toast({ title: 'Leveling settings saved', variant: 'success' }),
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
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  const channelMode: string =
    draft.levelUpChannel === 'current' || draft.levelUpChannel === 'dm' || draft.levelUpChannel === 'none'
      ? draft.levelUpChannel
      : 'channel';
  const dirty = data ? JSON.stringify(draft) !== JSON.stringify(data.leveling) : false;

  const filteredRows = (leaderboard.data?.items ?? []).filter((row) => row.userId.includes(search.trim()));

  const columns: DataTableColumn<LevelProfileDto>[] = [
    { key: 'userId', header: 'User ID', render: (r) => <code className="text-xs">{r.userId}</code> },
    { key: 'level', header: 'Level', render: (r) => r.level },
    { key: 'xp', header: 'XP', render: (r) => r.xp.toLocaleString() },
    { key: 'messages', header: 'Messages', render: (r) => r.messages.toLocaleString() },
    { key: 'voiceMinutes', header: 'Voice min', render: (r) => r.voiceMinutes.toLocaleString() },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Leveling settings</CardTitle>
          <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Leveling enabled</p>
              <p className="text-xs text-muted-foreground">
                Turn message/voice XP off without losing anyone&apos;s progress.
              </p>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => set('enabled', v)}
              disabled={update.isPending}
            />
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <FormField label="Min XP / message">
              <Input
                type="number"
                min={1}
                value={draft.xpPerMessageMin}
                onChange={(e) => set('xpPerMessageMin', Number(e.target.value))}
              />
            </FormField>
            <FormField label="Max XP / message">
              <Input
                type="number"
                min={1}
                value={draft.xpPerMessageMax}
                onChange={(e) => set('xpPerMessageMax', Number(e.target.value))}
              />
            </FormField>
            <FormField label="Cooldown (s)" hint="Anti-farming.">
              <Input
                type="number"
                min={0}
                value={draft.xpCooldownSeconds}
                onChange={(e) => set('xpCooldownSeconds', Number(e.target.value))}
              />
            </FormField>
            <FormField label="Max XP / hour">
              <Input
                type="number"
                min={1}
                value={draft.maxXpPerHour}
                onChange={(e) => set('maxXpPerHour', Number(e.target.value))}
              />
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              label="Voice XP / minute"
              hint="0 disables voice XP. Requires 2+ unmuted humans in the channel."
            >
              <Input
                type="number"
                min={0}
                value={draft.voiceXpPerMinute}
                onChange={(e) => set('voiceXpPerMinute', Number(e.target.value))}
              />
            </FormField>
            <FormField
              label="Reward mode"
              hint="Stack keeps every earned role; replace keeps only the highest."
            >
              <Select
                value={draft.rewardMode}
                onValueChange={(v) => set('rewardMode', v as 'stack' | 'replace')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stack">Stack</SelectItem>
                  <SelectItem value="replace">Replace</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Level-up announcement">
              <Select
                value={channelMode}
                onValueChange={(v) =>
                  set(
                    'levelUpChannel',
                    v === 'channel'
                      ? draft.levelUpChannel === 'current' ||
                        draft.levelUpChannel === 'dm' ||
                        draft.levelUpChannel === 'none'
                        ? ''
                        : draft.levelUpChannel
                      : v,
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVEL_UP_CHANNEL_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            {channelMode === 'channel' ? (
              <FormField label="Channel">
                <DiscordChannelSelect
                  guildId={guildId}
                  value={
                    draft.levelUpChannel === 'current' ||
                    draft.levelUpChannel === 'dm' ||
                    draft.levelUpChannel === 'none'
                      ? null
                      : draft.levelUpChannel
                  }
                  onChange={(v) => set('levelUpChannel', v ?? '')}
                />
              </FormField>
            ) : null}
          </div>

          <FormField label="Level-up message" hint="{user} and {level} are replaced.">
            <Textarea
              value={draft.levelUpMessage}
              onChange={(e) => set('levelUpMessage', e.target.value)}
              rows={2}
              maxLength={500}
            />
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Ignored channels" hint="No XP is earned for activity in these channels.">
              <MultiChannelPicker
                guildId={guildId}
                value={draft.ignoredChannelIds}
                onChange={(v) => set('ignoredChannelIds', v)}
                kinds={['text', 'announcement', 'forum', 'voice']}
              />
            </FormField>
            <FormField label="Ignored roles" hint="Members with any of these roles never earn XP.">
              <MultiRolePicker
                guildId={guildId}
                value={draft.ignoredRoleIds}
                onChange={(v) => set('ignoredRoleIds', v)}
              />
            </FormField>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Level-role rewards</CardTitle>
        </CardHeader>
        <CardContent>
          <RewardsEditor guildId={guildId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Leaderboard</CardTitle>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Search by user ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56"
            />
            <Button size="sm" variant="outline" onClick={() => setXpDialogOpen(true)}>
              <Trophy className="h-4 w-4" />
              Adjust XP
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Ranked members" value={(leaderboard.data?.items.length ?? 0).toLocaleString()} />
            <StatCard
              label="Top level"
              value={Math.max(0, ...(leaderboard.data?.items.map((r) => r.level) ?? [0]))}
            />
            <StatCard
              label="Total XP shown"
              value={(leaderboard.data?.items.reduce((sum, r) => sum + r.xp, 0) ?? 0).toLocaleString()}
            />
          </div>
          <DataTable
            columns={columns}
            rows={filteredRows}
            rowKey={(r) => r.userId}
            loading={leaderboard.isLoading}
            error={leaderboard.error}
            onRetry={() => leaderboard.refetch()}
            emptyTitle="No ranked members yet"
            emptyDescription="The leaderboard fills in once members start earning XP."
          />
          <Pagination
            hasPrevious={cursorHistory.length > 0}
            hasNext={Boolean(leaderboard.data?.nextCursor)}
            loading={leaderboard.isFetching}
            label={cursor ? undefined : 'Page 1'}
            onPrevious={() => {
              setCursorHistory((prev) => {
                const next = [...prev];
                const last = next.pop();
                setCursor(last);
                return next;
              });
            }}
            onNext={() => {
              if (!leaderboard.data?.nextCursor) return;
              setCursorHistory((prev) => [...prev, cursor ?? '']);
              setCursor(leaderboard.data.nextCursor ?? undefined);
            }}
          />
        </CardContent>
      </Card>

      <XpAdjustDialog guildId={guildId} open={xpDialogOpen} onOpenChange={setXpDialogOpen} />
    </div>
  );
}
