'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
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
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from '@pavisie/ui';
import {
  useCreateRoleGroup,
  useDeleteRoleGroup,
  useRoleGroups,
  useUpdateRoleGroup,
  type RoleGroupInput,
} from '@/lib/dashboard/roles-queries';
import { MultiRolePicker } from '../multi-role-picker';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';

function emptyForm(): RoleGroupInput {
  return { name: '', roleIds: [], exclusive: false, maxSelections: null };
}

export function GroupsTab({
  guildId,
  onGroupsChange,
}: {
  guildId: string;
  onGroupsChange?: (groups: RoleGroupDto[]) => void;
}) {
  const { data: groups, isLoading, error, refetch } = useRoleGroups(guildId);
  const createGroup = useCreateRoleGroup(guildId);
  const updateGroup = useUpdateRoleGroup(guildId);
  const deleteGroup = useDeleteRoleGroup(guildId);
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<RoleGroupInput>(emptyForm());

  React.useEffect(() => {
    if (groups) onGroupsChange?.(groups);
  }, [groups, onGroupsChange]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setDialogOpen(true);
  }

  function openEdit(group: RoleGroupDto) {
    setEditingId(group.id);
    setForm({
      name: group.name,
      roleIds: group.roleIds,
      exclusive: group.exclusive,
      maxSelections: group.maxSelections,
    });
    setDialogOpen(true);
  }

  function handleSave() {
    if (!form.name.trim()) {
      toast({ title: 'Give the group a name.', variant: 'destructive' });
      return;
    }
    const onSettled = {
      onSuccess: () => {
        toast({ title: editingId ? 'Group updated' : 'Group created', variant: 'success' });
        setDialogOpen(false);
      },
      onError: (err: unknown) =>
        toast({
          title: 'Could not save the group',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    };
    if (editingId) {
      updateGroup.mutate({ groupId: editingId, ...form }, onSettled);
    } else {
      createGroup.mutate(form, onSettled);
    }
  }

  function handleDelete(groupId: string) {
    deleteGroup.mutate(groupId, { onSuccess: () => toast({ title: 'Group deleted', variant: 'success' }) });
  }

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="mr-1.5 h-4 w-4" /> New group
        </Button>
      </div>

      {!groups || groups.length === 0 ? (
        <EmptyState
          title="No role groups yet"
          description="Groups let a panel enforce exclusive picks or a max-selection limit."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <TableRow key={group.id}>
                <TableCell className="font-medium">{group.name}</TableCell>
                <TableCell>
                  {group.exclusive ? (
                    <Badge>Exclusive (max 1)</Badge>
                  ) : group.maxSelections ? (
                    <Badge variant="secondary">Max {group.maxSelections}</Badge>
                  ) : (
                    <Badge variant="outline">No limit</Badge>
                  )}
                </TableCell>
                <TableCell>{group.roleIds.length}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" onClick={() => openEdit(group)}>
                      Edit
                    </Button>
                    <IconButton
                      label="Delete group"
                      size="sm"
                      variant="outline"
                      onClick={() => handleDelete(group.id)}
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit group' : 'New role group'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <FormField label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                maxLength={100}
              />
            </FormField>

            <FormField label="Roles">
              <MultiRolePicker
                guildId={guildId}
                value={form.roleIds}
                onChange={(v) => setForm((p) => ({ ...p, roleIds: v }))}
              />
            </FormField>

            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium">Exclusive</p>
                <p className="text-xs text-muted-foreground">
                  Selecting one role from this group removes the others.
                </p>
              </div>
              <Switch
                checked={form.exclusive}
                onCheckedChange={(v) => setForm((p) => ({ ...p, exclusive: v }))}
              />
            </div>

            {!form.exclusive ? (
              <FormField label="Max selections" hint="Leave blank for no limit.">
                <Input
                  type="number"
                  min={1}
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
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={createGroup.isPending || updateGroup.isPending}>
              {editingId ? 'Save changes' : 'Create group'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
