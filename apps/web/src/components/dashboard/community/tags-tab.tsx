'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  ColorPicker,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  useToast,
} from '@pavisie/ui';
import type { TagBodyDto, TagDto, TagTriggerModeDto } from '@pavisie/types/community';
import { ApiClientError } from '@/lib/dashboard/api';
import { useCommunityTags, useCreateTag, useDeleteTag, useUpdateTag } from '@/lib/dashboard/community-queries';
import { ConfirmDialog } from '../confirm-dialog';
import { DataTable, type DataTableColumn } from '../data-table';
import { MultiChannelPicker } from '../engagement/multi-channel-picker';

const TRIGGER_MODE_LABEL: Record<TagTriggerModeDto, string> = {
  NONE: 'Off',
  EXACT: 'Exact — whole message equals the phrase',
  CONTAINS: 'Contains — phrase appears as a whole word',
  STARTS_WITH: 'Starts with — message begins with the phrase',
};
const TRIGGER_MODE_SHORT: Record<TagTriggerModeDto, string> = {
  NONE: '',
  EXACT: 'exact',
  CONTAINS: 'contains',
  STARTS_WITH: 'starts with',
};
const TAG_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

interface DraftState {
  name: string;
  content: string;
  embedTitle: string;
  embedDescription: string;
  embedColor: string;
  embedImageUrl: string;
  embedFooter: string;
  staffOnly: boolean;
  triggerMode: TagTriggerModeDto;
  trigger: string;
  triggerChannelIds: string[];
}

function draftFromTag(tag: TagDto | null | undefined): DraftState {
  return {
    name: tag?.name ?? '',
    content: tag?.content ?? '',
    embedTitle: tag?.embed?.title ?? '',
    embedDescription: tag?.embed?.description ?? '',
    embedColor: tag?.embed?.colorHex ?? '',
    embedImageUrl: tag?.embed?.imageUrl ?? '',
    embedFooter: tag?.embed?.footer ?? '',
    staffOnly: tag?.staffOnly ?? false,
    triggerMode: tag?.triggerMode ?? 'NONE',
    trigger: tag?.trigger ?? '',
    triggerChannelIds: tag?.triggerChannelIds ?? [],
  };
}

function bodyFromDraft(draft: DraftState): TagBodyDto {
  const embedHasContent =
    draft.embedTitle.trim() ||
    draft.embedDescription.trim() ||
    draft.embedImageUrl.trim() ||
    draft.embedFooter.trim();
  return {
    name: draft.name.trim().toLowerCase(),
    content: draft.content.trim() ? draft.content : null,
    embed: embedHasContent
      ? {
          title: draft.embedTitle.trim() || undefined,
          description: draft.embedDescription.trim() || undefined,
          colorHex: draft.embedColor.trim() || undefined,
          imageUrl: draft.embedImageUrl.trim() || undefined,
          footer: draft.embedFooter.trim() || undefined,
        }
      : null,
    staffOnly: draft.staffOnly,
    triggerMode: draft.triggerMode,
    trigger: draft.triggerMode === 'NONE' ? null : draft.trigger.trim(),
    triggerChannelIds: draft.triggerMode === 'NONE' ? [] : draft.triggerChannelIds,
  };
}

interface TagFormDialogProps {
  guildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tag?: TagDto | null;
}

/** Create/edit dialog for a tag: name + plain content, optional flat embed, staff-only switch, and the keyword auto-responder settings. */
function TagFormDialog({ guildId, open, onOpenChange, tag }: TagFormDialogProps) {
  const isEdit = Boolean(tag);
  const [draft, setDraft] = React.useState<DraftState>(() => draftFromTag(tag));
  const createTag = useCreateTag(guildId);
  const updateTag = useUpdateTag(guildId);
  const { toast } = useToast();
  const saving = createTag.isPending || updateTag.isPending;

  // Re-seed the draft whenever the dialog opens or its target tag changes.
  React.useEffect(() => {
    if (open) setDraft(draftFromTag(tag));
  }, [open, tag]);

  function set<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    const body = bodyFromDraft(draft);
    if (!TAG_NAME_RE.test(body.name)) {
      toast({
        title: 'Invalid name',
        description: '1-32 lowercase letters, numbers, "-" or "_", starting with a letter or number.',
        variant: 'destructive',
      });
      return;
    }
    if (!body.content && !body.embed) {
      toast({ title: 'A tag needs content or an embed', variant: 'destructive' });
      return;
    }
    if (body.triggerMode !== 'NONE' && (!body.trigger || body.trigger.length < 2)) {
      toast({ title: 'Trigger phrase must be 2-100 characters', variant: 'destructive' });
      return;
    }

    const onSuccess = () => {
      toast({ title: isEdit ? 'Tag updated' : 'Tag created', variant: 'success' });
      onOpenChange(false);
    };
    const onError = (err: unknown) =>
      toast({
        title: 'Could not save the tag',
        description: err instanceof ApiClientError ? err.message : 'Please try again.',
        variant: 'destructive',
      });

    if (isEdit && tag) {
      updateTag.mutate({ tagId: tag.id, body }, { onSuccess, onError });
    } else {
      createTag.mutate(body, { onSuccess, onError });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit tag: ${tag?.name}` : 'New tag'}</DialogTitle>
          <DialogDescription>
            Members post a tag with <code>/tag show &lt;name&gt;</code>. Content supports{' '}
            <code>{'{user}'}</code>, <code>{'{user.tag}'}</code>, <code>{'{user.id}'}</code>,{' '}
            <code>{'{server}'}</code>, <code>{'{memberCount}'}</code> and <code>{'{mention}'}</code> — nothing
            else is ever evaluated, and tags never ping @everyone or roles.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Name" required hint="Lowercase letters, numbers, - or _ (max 32).">
            <Input
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              maxLength={32}
              disabled={saving}
              placeholder="rules"
            />
          </FormField>

          <FormField
            label="Content"
            hint="Plain text reply (max 2000 chars). Leave empty for an embed-only tag."
          >
            <Textarea
              value={draft.content}
              onChange={(e) => set('content', e.target.value)}
              rows={4}
              maxLength={2000}
              disabled={saving}
              placeholder="Read the {server} rules in #rules before posting."
            />
          </FormField>

          <div className="rounded-md border border-border p-3">
            <p className="mb-3 text-sm font-medium">Embed (optional)</p>
            <div className="space-y-3">
              <FormField label="Title">
                <Input
                  value={draft.embedTitle}
                  onChange={(e) => set('embedTitle', e.target.value)}
                  maxLength={256}
                  disabled={saving}
                />
              </FormField>
              <FormField label="Description">
                <Textarea
                  value={draft.embedDescription}
                  onChange={(e) => set('embedDescription', e.target.value)}
                  rows={3}
                  maxLength={4000}
                  disabled={saving}
                />
              </FormField>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField label="Color">
                  <ColorPicker
                    value={draft.embedColor}
                    onChange={(hex) => set('embedColor', hex)}
                    disabled={saving}
                  />
                </FormField>
                <FormField label="Image URL" hint="https:// only">
                  <Input
                    value={draft.embedImageUrl}
                    onChange={(e) => set('embedImageUrl', e.target.value)}
                    disabled={saving}
                    placeholder="https://…"
                  />
                </FormField>
              </div>
              <FormField label="Footer">
                <Input
                  value={draft.embedFooter}
                  onChange={(e) => set('embedFooter', e.target.value)}
                  maxLength={2048}
                  disabled={saving}
                />
              </FormField>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Staff only</p>
              <p className="text-xs text-muted-foreground">
                Only helpers and above can run /tag show for it.
              </p>
            </div>
            <Switch
              checked={draft.staffOnly}
              onCheckedChange={(v) => {
                // Staff-only tags can't be auto-responders (enforced server-side too) — clear any trigger
                // already set rather than let the toggle silently save a combination the API will reject.
                if (v) {
                  setDraft((prev) => ({
                    ...prev,
                    staffOnly: true,
                    triggerMode: 'NONE',
                    trigger: '',
                    triggerChannelIds: [],
                  }));
                } else {
                  set('staffOnly', false);
                }
              }}
              disabled={saving}
            />
          </div>

          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="text-sm font-medium">Auto-responder (optional)</p>
            {draft.staffOnly ? (
              <Alert>
                <AlertTitle>Not available for staff-only tags</AlertTitle>
                <AlertDescription>
                  Staff-only tags cannot be auto-responders. Turn off &quot;Staff only&quot; above if this tag
                  needs a keyword trigger.
                </AlertDescription>
              </Alert>
            ) : (
              <FormField label="Trigger mode">
                <Select
                  value={draft.triggerMode}
                  onValueChange={(v) => set('triggerMode', v as TagTriggerModeDto)}
                  disabled={saving}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(TRIGGER_MODE_LABEL) as TagTriggerModeDto[]).map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {TRIGGER_MODE_LABEL[mode]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}

            {!draft.staffOnly && draft.triggerMode !== 'NONE' ? (
              <>
                <Alert variant="warning">
                  <AlertTriangle />
                  <AlertTitle>Needs the Message Content intent</AlertTitle>
                  <AlertDescription>
                    Keyword triggers only run when the bot has the Message Content privileged intent enabled
                    <em> and </em>
                    the community plugin&apos;s <code>tags.triggersEnabled</code> setting is on (Plugins →
                    Community → config). Incoming messages are compared in memory and never stored. Replies
                    are rate-limited per tag (<code>tags.triggerCooldownSeconds</code>).
                  </AlertDescription>
                </Alert>
                <FormField label="Trigger phrase" required hint="2-100 characters, case-insensitive.">
                  <Input
                    value={draft.trigger}
                    onChange={(e) => set('trigger', e.target.value)}
                    minLength={2}
                    maxLength={100}
                    disabled={saving}
                    placeholder="how do i verify"
                  />
                </FormField>
                <FormField label="Channels" hint="Leave empty to respond in every channel.">
                  <MultiChannelPicker
                    guildId={guildId}
                    value={draft.triggerChannelIds}
                    onChange={(v) => set('triggerChannelIds', v)}
                    disabled={saving}
                  />
                </FormField>
              </>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create tag'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TagsTab({ guildId }: { guildId: string }) {
  const [search, setSearch] = React.useState('');
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];
  const { data, isLoading, error, refetch } = useCommunityTags(guildId, search.trim().toLowerCase(), cursor);
  const deleteTag = useDeleteTag(guildId);
  const { toast } = useToast();

  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TagDto | null>(null);
  const [deleting, setDeleting] = React.useState<TagDto | null>(null);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }
  function openEdit(tag: TagDto) {
    setEditing(tag);
    setFormOpen(true);
  }
  function confirmDelete() {
    if (!deleting) return;
    deleteTag.mutate(deleting.id, {
      onSuccess: () => {
        toast({ title: `Deleted tag "${deleting.name}"`, variant: 'success' });
        setDeleting(null);
      },
      onError: (err) =>
        toast({
          title: 'Could not delete',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  const columns: DataTableColumn<TagDto>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (t) => (
        <span className="font-mono text-sm">
          {t.name}
          {t.embed ? (
            <Badge variant="outline" className="ml-2">
              embed
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'trigger',
      header: 'Trigger',
      render: (t) =>
        t.triggerMode === 'NONE' || !t.trigger ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span>
            <Badge variant="secondary" className="mr-1">
              {TRIGGER_MODE_SHORT[t.triggerMode]}
            </Badge>
            <span className="font-mono text-xs">&quot;{t.trigger}&quot;</span>
            {t.triggerChannelIds.length > 0 ? (
              <span className="ml-1 text-xs text-muted-foreground">
                ({t.triggerChannelIds.length} channel{t.triggerChannelIds.length === 1 ? '' : 's'})
              </span>
            ) : null}
          </span>
        ),
    },
    { key: 'uses', header: 'Uses', render: (t) => t.uses },
    {
      key: 'staffOnly',
      header: 'Staff only',
      render: (t) =>
        t.staffOnly ? (
          <Badge variant="default">Yes</Badge>
        ) : (
          <span className="text-muted-foreground">No</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      render: (t) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => openEdit(t)}>
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDeleting(t)}>
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCursorStack([undefined]);
            }}
            placeholder="Filter by name…"
            className="w-56"
            maxLength={32}
          />
          <Button onClick={openCreate}>New tag</Button>
        </div>

        <DataTable
          columns={columns}
          rows={data?.items}
          rowKey={(t) => t.id}
          loading={isLoading}
          error={error}
          onRetry={() => refetch()}
          emptyTitle="No tags yet"
          emptyDescription='Create one with "New tag" or /tag create in Discord. Members run them with /tag show.'
        />
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={Boolean(data?.nextCursor)}
          loading={isLoading}
          label={`${data?.items.length ?? 0} shown`}
          onPrevious={() => setCursorStack((stack) => stack.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((stack) => [...stack, data.nextCursor!])}
        />
      </CardContent>

      <TagFormDialog guildId={guildId} open={formOpen} onOpenChange={setFormOpen} tag={editing} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete tag "${deleting?.name}"?`}
        description="This permanently deletes the tag and its auto-responder. The audit log keeps a record."
        variant="destructive"
        confirmLabel="Delete"
        loading={deleteTag.isPending}
        onConfirm={confirmDelete}
      />
    </Card>
  );
}
