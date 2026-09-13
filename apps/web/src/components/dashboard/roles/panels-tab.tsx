'use client';

import * as React from 'react';
import { Plus, Send, Trash2 } from 'lucide-react';
import type { RolePanelDto } from '@pavisie/types';
import type { RoleGroupDto } from '@pavisie/types/roles';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  FormField,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  useToast,
} from '@pavisie/ui';
import {
  useRolePanels,
  useCreateRolePanel,
  useUpdateRolePanel,
  useDeleteRolePanel,
  usePostRolePanel,
  type RolePanelInput,
  type RolePanelOptionInput,
} from '@/lib/dashboard/roles-queries';
import { DiscordChannelSelect, DiscordRoleSelect } from '../discord-selects';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';

const STYLE_LABEL: Record<string, string> = {
  BUTTONS: 'Buttons',
  SELECT: 'Select menu',
  REACTIONS: 'Reactions',
};

function emptyOption(): RolePanelOptionInput {
  return { roleId: '', label: '', emoji: '', description: '' };
}

function emptyForm(): RolePanelInput {
  return {
    channelId: '',
    title: '',
    description: '',
    style: 'BUTTONS',
    groupId: null,
    maxSelections: null,
    options: [emptyOption()],
  };
}

export function PanelsTab({ guildId, groups }: { guildId: string; groups: RoleGroupDto[] }) {
  const { data: panels, isLoading, error, refetch } = useRolePanels(guildId);
  const createPanel = useCreateRolePanel(guildId);
  const updatePanel = useUpdateRolePanel(guildId);
  const deletePanel = useDeleteRolePanel(guildId);
  const postPanel = usePostRolePanel(guildId);
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<RolePanelInput>(emptyForm());

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setDialogOpen(true);
  }

  function openEdit(panel: RolePanelDto) {
    setEditingId(panel.id);
    setForm({
      channelId: panel.channelId ?? '',
      title: panel.title,
      description: panel.description ?? '',
      style: panel.mode === 'button' ? 'BUTTONS' : panel.mode === 'select' ? 'SELECT' : 'REACTIONS',
      groupId: null,
      maxSelections: panel.maxSelections,
      options:
        panel.options.length > 0
          ? panel.options.map((o) => ({
              roleId: o.roleId,
              label: o.label,
              emoji: o.emoji ?? '',
              description: o.description ?? '',
            }))
          : [emptyOption()],
    });
    setDialogOpen(true);
  }

  function setOption(index: number, patch: Partial<RolePanelOptionInput>) {
    setForm((prev) => ({
      ...prev,
      options: prev.options.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    }));
  }

  function addOption() {
    setForm((prev) => ({ ...prev, options: [...prev.options, emptyOption()] }));
  }

  function removeOption(index: number) {
    setForm((prev) => ({ ...prev, options: prev.options.filter((_, i) => i !== index) }));
  }

  function handleSave() {
    const options = form.options.filter((o) => o.roleId && o.label.trim());
    if (!form.channelId || !form.title.trim() || options.length === 0) {
      toast({ title: 'Fill in the channel, title, and at least one role option.', variant: 'destructive' });
      return;
    }
    const payload = { ...form, options };
    const onSettled = {
      onSuccess: () => {
        toast({ title: editingId ? 'Panel updated' : 'Panel created', variant: 'success' });
        setDialogOpen(false);
      },
      onError: (err: unknown) =>
        toast({
          title: 'Could not save the panel',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    };
    if (editingId) {
      updatePanel.mutate({ panelId: editingId, ...payload }, onSettled);
    } else {
      createPanel.mutate(payload, onSettled);
    }
  }

  function handlePost(panelId: string) {
    postPanel.mutate(panelId, {
      onSuccess: () =>
        toast({ title: 'Posting queued — check the channel in a few seconds.', variant: 'success' }),
      onError: (err) =>
        toast({
          title: 'Could not post the panel',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  function handleDelete(panelId: string) {
    deletePanel.mutate(panelId, { onSuccess: () => toast({ title: 'Panel deleted', variant: 'success' }) });
  }

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="mr-1.5 h-4 w-4" /> New panel
        </Button>
      </div>

      {!panels || panels.length === 0 ? (
        <EmptyState
          title="No role panels yet"
          description="Create one so members can pick their own roles."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Style</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Options</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {panels.map((panel) => (
              <TableRow key={panel.id}>
                <TableCell className="font-medium">{panel.title}</TableCell>
                <TableCell>
                  {
                    STYLE_LABEL[
                      panel.mode === 'button' ? 'BUTTONS' : panel.mode === 'select' ? 'SELECT' : 'REACTIONS'
                    ]
                  }
                </TableCell>
                <TableCell>
                  {panel.channelId ? <code className="text-xs">{panel.channelId}</code> : '—'}
                </TableCell>
                <TableCell>{panel.options.length}</TableCell>
                <TableCell>
                  {panel.messageId ? (
                    <Badge variant="secondary">Posted</Badge>
                  ) : (
                    <Badge variant="outline">Not posted</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handlePost(panel.id)}
                      disabled={postPanel.isPending}
                    >
                      <Send className="mr-1 h-3.5 w-3.5" /> Post
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => openEdit(panel)}>
                      Edit
                    </Button>
                    <IconButton
                      label="Delete panel"
                      size="sm"
                      variant="outline"
                      onClick={() => handleDelete(panel.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit panel' : 'New role panel'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="Title">
                <Input
                  value={form.title}
                  onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                  maxLength={100}
                />
              </FormField>
              <FormField label="Style">
                <Select
                  value={form.style}
                  onValueChange={(v) => setForm((p) => ({ ...p, style: v as RolePanelInput['style'] }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BUTTONS">Buttons</SelectItem>
                    <SelectItem value="SELECT">Select menu</SelectItem>
                    <SelectItem value="REACTIONS">Reactions</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            <FormField label="Description" hint="Optional, shown above the options in the posted embed.">
              <Textarea
                value={form.description ?? ''}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                maxLength={2000}
                rows={2}
              />
            </FormField>

            <div className="grid grid-cols-2 gap-4">
              <FormField label="Channel">
                <DiscordChannelSelect
                  guildId={guildId}
                  value={form.channelId || null}
                  onChange={(v) => setForm((p) => ({ ...p, channelId: v ?? '' }))}
                />
              </FormField>
              <FormField
                label="Group (optional)"
                hint="Exclusive / max-selection rules shared across panels."
              >
                <Select
                  value={form.groupId ?? '__none__'}
                  onValueChange={(v) => setForm((p) => ({ ...p, groupId: v === '__none__' ? null : v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No group" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No group</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            <FormField label="Max selections (select style)" hint="Leave blank for one-per-role behavior.">
              <Input
                type="number"
                min={0}
                max={25}
                value={form.maxSelections ?? ''}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    maxSelections: e.target.value === '' ? null : Number(e.target.value),
                  }))
                }
              />
            </FormField>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Options</p>
                <Button size="sm" variant="outline" onClick={addOption} disabled={form.options.length >= 25}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add option
                </Button>
              </div>
              <div className="space-y-2">
                {form.options.map((option, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_1fr_4rem_1fr_auto] items-end gap-2 rounded-md border border-border p-2"
                  >
                    <FormField label="Role">
                      <DiscordRoleSelect
                        guildId={guildId}
                        value={option.roleId || null}
                        onChange={(v) => setOption(i, { roleId: v ?? '' })}
                      />
                    </FormField>
                    <FormField label="Label">
                      <Input
                        value={option.label}
                        onChange={(e) => setOption(i, { label: e.target.value })}
                        maxLength={80}
                      />
                    </FormField>
                    <FormField label="Emoji">
                      <Input
                        value={option.emoji ?? ''}
                        onChange={(e) => setOption(i, { emoji: e.target.value })}
                        maxLength={64}
                      />
                    </FormField>
                    <FormField label="Description">
                      <Input
                        value={option.description ?? ''}
                        onChange={(e) => setOption(i, { description: e.target.value })}
                        maxLength={200}
                      />
                    </FormField>
                    <IconButton
                      label="Remove option"
                      variant="outline"
                      onClick={() => removeOption(i)}
                      disabled={form.options.length <= 1}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                ))}
              </div>
              {form.style === 'REACTIONS' ? (
                <p className="text-xs text-muted-foreground">
                  Reaction-style panels need an emoji on every option.
                </p>
              ) : null}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={createPanel.isPending || updatePanel.isPending}>
              {editingId ? 'Save changes' : 'Create panel'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
