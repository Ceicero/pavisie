'use client';

import * as React from 'react';
import { RotateCcw, Trophy } from 'lucide-react';
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
  useResetLeveling,
  useUpdateEngagementConfig,
} from '@/lib/dashboard/engagement-queries';
import { useGuildChannels, useGuildRoles } from '@/lib/dashboard/queries';
import { DataTable, type DataTableColumn } from '../data-table';
import { DiscordChannelSelect } from '../discord-selects';
import { MultiRolePicker } from '../multi-role-picker';
import { ConfirmDialog } from '../confirm-dialog';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';
import { XpAdjustDialog } from './xp-adjust-dialog';
import { RewardsEditor } from './rewards-editor';
import { MultiChannelPicker } from './multi-channel-picker';

/** Same bounds as `clampXpMultiplier` in the engagement plugin. The API clamps again on save. */
const XP_MULTIPLIER_MIN = 0.25;
const XP_MULTIPLIER_MAX = 5;

function clampXpMultiplier(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(XP_MULTIPLIER_MAX, Math.max(XP_MULTIPLIER_MIN, value));
}

type XpMultiplierEntry = { id: string; multiplier: number };

function MultiplierList({
  guildId,
  kind,
  entries,
  onChange,
  disabled,
}: {
  guildId: string;
  kind: 'role' | 'channel';
  entries: XpMultiplierEntry[];
  onChange: (next: XpMultiplierEntry[]) => void;
  disabled?: boolean;
}) {
  const roles = useGuildRoles(kind === 'role' ? guildId : undefined);
  const channels = useGuildChannels(kind === 'channel' ? guildId : undefined);
  const [text, setText] = React.useState<Record<string, string>>({});
  const ids = entries.map((entry) => entry.id);

  function label(id: string): string {
    if (kind === 'role') return roles.data?.find((role) => role.id === id)?.name ?? id;
    const name = channels.data?.find((channel) => channel.id === id)?.name;
    return name ? `#${name}` : id;
  }

  function syncIds(nextIds: string[]) {
    onChange(nextIds.map((id) => entries.find((entry) => entry.id === id) ?? { id, multiplier: 2 }));
    setText((prev) => {
      const next: Record<string, string> = {};
      for (const id of nextIds) {
        const value = prev[id];
        if (value !== undefined) next[id] = value;
      }
      return next;
    });
  }

  function commit(id: string, raw: string) {
    const multiplier = clampXpMultiplier(Number(raw));
    onChange(entries.map((entry) => (entry.id === id ? { ...entry, multiplier } : entry)));
    setText((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  return (
    <div className="space-y-2">
      {kind === 'role' ? (
        <MultiRolePicker guildId={guildId} value={ids} onChange={syncIds} disabled={disabled} />
      ) : (
        <MultiChannelPicker
          guildId={guildId}
          value={ids}
          onChange={syncIds}
          kinds={['text', 'announcement', 'forum', 'voice']}
          disabled={disabled}
        />
      )}
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{label(entry.id)}</span>
          <Input
            type="number"
            aria-label={`XP multiplier for ${label(entry.id)}`}
            min={XP_MULTIPLIER_MIN}
            max={XP_MULTIPLIER_MAX}
            step={0.05}
            className="w-24"
            disabled={disabled}
            value={text[entry.id] ?? String(entry.multiplier)}
            onChange={(event) => {
              const raw = event.target.value;
              setText((prev) => ({ ...prev, [entry.id]: raw }));
              const value = Number(raw);
              if (raw.trim() !== '' && Number.isFinite(value)) {
                onChange(
                  entries.map((item) => (item.id === entry.id ? { ...item, multiplier: value } : item)),
                );
              }
            }}
            onBlur={(event) => commit(entry.id, event.target.value)}
          />
        </div>
      ))}
    </div>
  );
}

const LEVEL_UP_CHANNEL_MODES = [
  { value: 'current', label: 'Wherever the message was sent' },
  { value: 'dm', label: 'Direct message' },
  { value: 'none', label: "Don't announce" },
  { value: 'channel', label: 'Specific channel' },
];

export function LevelingTab({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useEngagementConfig(guildId);
  const update = useUpdateEngagementConfig(guildId);
  const reset = useResetLeveling(guildId);
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<EngagementConfigDto['leveling'] | null>(null);
  const [xpDialogOpen, setXpDialogOpen] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [cursor, setCursor] = React.useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!data) return;
    setDraft({
      ...data.leveling,
      roleMultipliers: data.leveling.roleMultipliers ?? [],
      channelMultipliers: data.leveling.channelMultipliers ?? [],
    });
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
    const leveling = {
      ...draft,
      roleMultipliers: draft.roleMultipliers.map((entry) => ({
        ...entry,
        multiplier: clampXpMultiplier(entry.multiplier),
      })),
      channelMultipliers: draft.channelMultipliers.map((entry) => ({
        ...entry,
        multiplier: clampXpMultiplier(entry.multiplier),
      })),
    };
    setDraft(leveling);
    update.mutate(
      { leveling },
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

  function handleReset() {
    reset.mutate(undefined, {
      onSuccess: (result) => {
        setResetOpen(false);
        toast({
          title: 'Leveling reset',
          description: `Cleared ${result.count.toLocaleString()} profile(s). Reward roles update shortly after, not instantly.`,
          variant: 'success',
        });
      },
      onError: (err) =>
        toast({
          title: 'Could not reset leveling',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
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

          <div className="space-y-3 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">XP multipliers</p>
              <p className="text-xs text-muted-foreground">
                The highest matching role wins, and the highest matching channel wins. A thread counts its own
                channel and its parent, so a parent multiplier still applies inside the thread. The XP factor
                is the larger of the role factor and the channel factor; they are not multiplied. A side with
                no entry is left out, so a 0.25 role still reduces XP in a channel that has no multiplier. A
                stored 1 does count. Range 0.25–5, and a new entry starts at 2×. Message XP rolls your min–max
                first, then this factor is applied and floored, then the hourly cap limits what is granted.
                Voice XP uses the same factor and is not part of that cap.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Role XP multipliers">
                <MultiplierList
                  guildId={guildId}
                  kind="role"
                  entries={draft.roleMultipliers}
                  onChange={(value) => set('roleMultipliers', value)}
                  disabled={update.isPending}
                />
              </FormField>
              <FormField label="Channel XP multipliers" hint="Text, announcement, forum, and voice channels.">
                <MultiplierList
                  guildId={guildId}
                  kind="channel"
                  entries={draft.channelMultipliers}
                  onChange={(value) => set('channelMultipliers', value)}
                  disabled={update.isPending}
                />
              </FormField>
            </div>
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
              aria-label="Search leaderboard by user ID"
              placeholder="Search by user ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-56"
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

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Reset leveling</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Clears every member&apos;s XP, level, message count, and voice minutes in this server. Reward
            roles update shortly after, not instantly. This cannot be undone.
          </p>
          <Button variant="destructive" onClick={() => setResetOpen(true)} disabled={reset.isPending}>
            <RotateCcw className="h-4 w-4" />
            Reset all XP
          </Button>
        </CardContent>
      </Card>

      <XpAdjustDialog guildId={guildId} open={xpDialogOpen} onOpenChange={setXpDialogOpen} />
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset leveling for everyone?"
        description="This clears every member's XP, level, message count, and voice minutes in this server. Reward roles update shortly after, not instantly. This cannot be undone."
        confirmLabel="Reset leveling"
        variant="destructive"
        loading={reset.isPending}
        onConfirm={handleReset}
      />
    </div>
  );
}
