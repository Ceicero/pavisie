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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useToast,
} from '@pavisie/ui';
import type { BirthdayConfigDto } from '@pavisie/types/community';
import { useBirthdaySummary, useRemoveBirthday, useUpdateBirthdayConfig } from '@/lib/dashboard/community-queries';
import { useGuildConfig } from '@/lib/dashboard/queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '../confirm-dialog';
import { DiscordChannelSelect, DiscordRoleSelect } from '../discord-selects';
import { ErrorState } from '../error-state';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

function pickConfig(dto: BirthdayConfigDto): BirthdayConfigDto {
  return {
    enabled: dto.enabled,
    channelId: dto.channelId,
    message: dto.message,
    announceHour: dto.announceHour,
    roleId: dto.roleId,
    publicList: dto.publicList,
    allowSelfService: dto.allowSelfService,
  };
}

function inDaysLabel(inDays: number): string {
  if (inDays === 0) return 'today';
  if (inDays === 1) return 'tomorrow';
  return `in ${inDays} days`;
}

/**
 * Birthdays tab: announcement settings + a privacy-light summary (count + next few upcoming, ids only).
 * There is deliberately no full member table here — the API only exposes a summary.
 */
export function BirthdaysTab({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useBirthdaySummary(guildId);
  const guildConfig = useGuildConfig(guildId);
  const update = useUpdateBirthdayConfig(guildId);
  const remove = useRemoveBirthday(guildId);
  const { toast } = useToast();
  const [draft, setDraft] = React.useState<BirthdayConfigDto | null>(null);
  const [removeTarget, setRemoveTarget] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (data) setDraft(pickConfig(data));
  }, [data]);

  function set<K extends keyof BirthdayConfigDto>(key: K, value: BirthdayConfigDto[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleSave() {
    if (!draft) return;
    update.mutate(draft, {
      onSuccess: () => toast({ title: 'Birthday settings saved', variant: 'success' }),
      onError: (err) =>
        toast({
          title: 'Could not save',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  function handleRemove() {
    if (!removeTarget) return;
    remove.mutate(removeTarget, {
      onSuccess: () => {
        toast({ title: 'Birthday removed', variant: 'success' });
        setRemoveTarget(null);
      },
      onError: (err) =>
        toast({
          title: 'Could not remove',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading || !data || !draft) return <Skeleton className="h-64 w-full" />;

  const dirty = JSON.stringify(draft) !== JSON.stringify(pickConfig(data));
  const timezone = guildConfig.data?.timezone ?? 'UTC';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Birthday announcements</CardTitle>
          <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
            Members opt in with <code>/birthday set</code> and can remove themselves any time. Only the month
            and day are stored — never a year or age — and the bot never DMs anyone about birthdays.
          </p>

          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Enabled</p>
              <p className="text-xs text-muted-foreground">
                Announce birthdays in the channel below and let members set theirs.
              </p>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => set('enabled', v)}
              disabled={update.isPending}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Announcement channel" hint="Required for announcements to post.">
              <DiscordChannelSelect
                guildId={guildId}
                value={draft.channelId}
                onChange={(v) => set('channelId', v)}
                placeholder="Not set"
              />
            </FormField>
            <FormField label="Announce at" hint={`Hour of the day in the server's timezone (${timezone}).`}>
              <Select
                value={String(draft.announceHour)}
                onValueChange={(v) => set('announceHour', Number(v))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {String(h).padStart(2, '0')}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              label="Birthday role (optional)"
              hint="Added for about 24 hours on the day. Never an elevated or managed role, and it must sit below the bot's top role."
            >
              <DiscordRoleSelect
                guildId={guildId}
                value={draft.roleId}
                onChange={(v) => set('roleId', v)}
                placeholder="No role"
              />
            </FormField>
            <FormField label="Message" hint="Tokens: {mention} {user} {server}">
              <Input value={draft.message} maxLength={500} onChange={(e) => set('message', e.target.value)} />
            </FormField>
          </div>

          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Public list</p>
              <p className="text-xs text-muted-foreground">
                Let members run <code>/birthday upcoming</code> and view each other&apos;s birthday. When off,
                only staff can.
              </p>
            </div>
            <Switch
              checked={draft.publicList}
              onCheckedChange={(v) => set('publicList', v)}
              disabled={update.isPending}
            />
          </div>

          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Members can set their own birthday</p>
              <p className="text-xs text-muted-foreground">
                Turn this off to let only admins add or change birthdays (with <code>/birthday set @member</code>).
                Members can still be set up on their behalf.
              </p>
            </div>
            <Switch
              checked={draft.allowSelfService}
              onCheckedChange={(v) => set('allowSelfService', v)}
              disabled={update.isPending}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {data.count} {data.count === 1 ? 'member has' : 'members have'} shared a birthday
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.next.length === 0 ? (
            <p className="text-sm text-muted-foreground">No birthdays registered yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.next.map((b) => (
                <li key={b.userId} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <code className="text-xs">{b.userId}</code>
                    <span>
                      {MONTH_SHORT[b.month - 1]} {b.day}
                    </span>
                    <span className="text-xs text-muted-foreground">({inDaysLabel(b.inDays)})</span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRemoveTarget(b.userId)}
                    disabled={remove.isPending}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Showing the next {Math.min(data.next.length, 10)} upcoming, by user id only. Removing an entry is
            audited (user id only) and meant for cleanup or abuse handling — members can always remove their
            own with <code>/birthday remove</code>.
          </p>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title="Remove this member's birthday?"
        description={
          removeTarget ? (
            <>
              User <code>{removeTarget}</code> will no longer be announced here. They can set it again with{' '}
              <code>/birthday set</code>.
            </>
          ) : null
        }
        confirmLabel="Remove"
        variant="destructive"
        loading={remove.isPending}
        onConfirm={handleRemove}
      />
    </div>
  );
}
