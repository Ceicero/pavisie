'use client';

import * as React from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from '@pavisie/ui';
import type { SuggestionDto } from '@pavisie/types/community';
import { ApiClientError } from '@/lib/dashboard/api';
import { useCommunitySuggestions, useUpdateSuggestionStatus } from '@/lib/dashboard/community-queries';
import { DataTable, type DataTableColumn } from '../data-table';

const STATUS_OPTIONS: SuggestionDto['status'][] = [
  'PENDING',
  'CONSIDERING',
  'APPROVED',
  'DENIED',
  'IMPLEMENTED',
];
const STATUS_LABEL: Record<SuggestionDto['status'], string> = {
  PENDING: 'Pending',
  CONSIDERING: 'Considering',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  IMPLEMENTED: 'Implemented',
};
const STATUS_BADGE: Record<
  SuggestionDto['status'],
  'default' | 'secondary' | 'success' | 'destructive' | 'outline'
> = {
  PENDING: 'outline',
  CONSIDERING: 'secondary',
  APPROVED: 'success',
  DENIED: 'destructive',
  IMPLEMENTED: 'default',
};

export function SuggestionsTab({ guildId }: { guildId: string }) {
  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];
  const { data, isLoading, error, refetch } = useCommunitySuggestions(
    guildId,
    statusFilter === 'all' ? undefined : statusFilter,
    cursor,
  );
  const updateStatus = useUpdateSuggestionStatus(guildId);
  const { toast } = useToast();

  const [editing, setEditing] = React.useState<SuggestionDto | null>(null);
  const [draftStatus, setDraftStatus] = React.useState<SuggestionDto['status']>('PENDING');
  const [draftNote, setDraftNote] = React.useState('');

  function openEditor(suggestion: SuggestionDto) {
    setEditing(suggestion);
    setDraftStatus(suggestion.status);
    setDraftNote(suggestion.staffNote ?? '');
  }

  function handleSave() {
    if (!editing) return;
    updateStatus.mutate(
      { suggestionId: editing.id, status: draftStatus, staffNote: draftNote },
      {
        onSuccess: () => {
          toast({ title: `Suggestion #${editing.number} updated`, variant: 'success' });
          setEditing(null);
        },
        onError: (err) =>
          toast({
            title: 'Could not update',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  const columns: DataTableColumn<SuggestionDto>[] = [
    { key: 'number', header: '#', render: (s) => `#${s.number}` },
    {
      key: 'content',
      header: 'Suggestion',
      render: (s) => <span>{s.content.length > 80 ? `${s.content.slice(0, 80)}…` : s.content}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (s) => <Badge variant={STATUS_BADGE[s.status]}>{STATUS_LABEL[s.status]}</Badge>,
    },
    { key: 'votes', header: 'Votes', render: (s) => `👍 ${s.upvotes} · 👎 ${s.downvotes}` },
    {
      key: 'edit',
      header: '',
      render: (s) => (
        <Button size="sm" variant="outline" onClick={() => openEditor(s)}>
          Update
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DataTable
          columns={columns}
          rows={data?.items}
          rowKey={(s) => s.id}
          loading={isLoading}
          error={error}
          onRetry={() => refetch()}
          emptyTitle="No suggestions yet"
          emptyDescription="Run /suggest in Discord to submit one."
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

      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `Suggestion #${editing.number}` : 'Suggestion'}</DialogTitle>
          </DialogHeader>
          {editing ? (
            <div className="space-y-4">
              <p className="rounded-md border border-border bg-muted/40 p-3 text-sm">{editing.content}</p>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Status</label>
                <Select
                  value={draftStatus}
                  onValueChange={(v) => setDraftStatus(v as SuggestionDto['status'])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((s) => (
                      <SelectItem key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Staff note (optional)</label>
                <Textarea
                  value={draftNote}
                  onChange={(e) => setDraftNote(e.target.value)}
                  rows={3}
                  placeholder="Shown on the suggestion, and DMed to the author if enabled."
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={updateStatus.isPending}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={updateStatus.isPending}>
              {updateStatus.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
