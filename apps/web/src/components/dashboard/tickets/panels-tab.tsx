'use client';

import * as React from 'react';
import { MessageSquarePlus, Pencil, Send, Trash2 } from 'lucide-react';
import type { TicketPanelDto } from '@pavisie/types/tickets';
import { Badge, Button, Card, CardContent, EmptyState, Skeleton, useToast } from '@pavisie/ui';
import { ApiClientError } from '@/lib/dashboard/api';
import { useDeleteTicketPanel, usePostTicketPanel, useTicketPanels } from '@/lib/dashboard/tickets-queries';
import { ConfirmDialog } from '../confirm-dialog';
import { ErrorState } from '../error-state';
import { PanelFormDialog } from './panel-form-dialog';

export interface TicketsPanelsTabProps {
  guildId: string;
}

export function TicketsPanelsTab({ guildId }: TicketsPanelsTabProps) {
  const { data: panels, isLoading, error, refetch } = useTicketPanels(guildId);
  const deletePanel = useDeleteTicketPanel(guildId);
  const postPanel = usePostTicketPanel(guildId);
  const { toast } = useToast();

  const [formOpen, setFormOpen] = React.useState(false);
  const [editingPanel, setEditingPanel] = React.useState<TicketPanelDto | undefined>(undefined);
  const [deletingPanel, setDeletingPanel] = React.useState<TicketPanelDto | null>(null);

  function openCreate() {
    setEditingPanel(undefined);
    setFormOpen(true);
  }

  function openEdit(panel: TicketPanelDto) {
    setEditingPanel(panel);
    setFormOpen(true);
  }

  function handlePost(panel: TicketPanelDto) {
    postPanel.mutate(panel.id, {
      onSuccess: () =>
        toast({
          title: `Posting "${panel.title}"…`,
          description: 'The bot will post it shortly.',
          variant: 'success',
        }),
      onError: (err) =>
        toast({
          title: 'Could not post panel',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  function handleDelete() {
    if (!deletingPanel) return;
    deletePanel.mutate(deletingPanel.id, {
      onSuccess: () => {
        toast({ title: 'Panel deleted', variant: 'success' });
        setDeletingPanel(null);
      },
      onError: (err) =>
        toast({
          title: 'Could not delete panel',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <MessageSquarePlus className="h-4 w-4" />
          New panel
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : !panels || panels.length === 0 ? (
        <EmptyState
          icon={<MessageSquarePlus />}
          title="No ticket panels yet"
          description="Create a panel to let members open tickets with a button."
          action={<Button onClick={openCreate}>New panel</Button>}
        />
      ) : (
        <div className="space-y-3">
          {panels.map((panel) => (
            <Card key={panel.id}>
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-foreground">{panel.title}</p>
                    <Badge variant="outline">
                      {panel.mode === 'CHANNEL' ? 'Private channel' : 'Private thread'}
                    </Badge>
                    {panel.intakeForm && panel.intakeForm.length > 0 ? (
                      <Badge variant="secondary">Intake form</Badge>
                    ) : null}
                    {!panel.messageId ? <Badge variant="warning">Not posted</Badge> : null}
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{panel.description}</p>
                  <p className="text-xs text-muted-foreground">
                    #{panel.channelId} · Support roles:{' '}
                    {panel.supportRoleIds.length > 0 ? panel.supportRoleIds.length : 'server default'} · SLA:{' '}
                    {panel.slaMinutes ? `${panel.slaMinutes}m` : 'server default'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePost(panel)}
                    disabled={postPanel.isPending}
                  >
                    <Send className="h-4 w-4" />
                    {panel.messageId ? 'Re-post' : 'Post'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => openEdit(panel)}
                    aria-label={`Edit ${panel.title}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeletingPanel(panel)}
                    aria-label={`Delete ${panel.title}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <PanelFormDialog guildId={guildId} open={formOpen} onOpenChange={setFormOpen} panel={editingPanel} />

      <ConfirmDialog
        open={deletingPanel !== null}
        onOpenChange={(open) => !open && setDeletingPanel(null)}
        title={`Delete "${deletingPanel?.title}"?`}
        description="The posted panel message is left as-is in Discord, but its button will stop working."
        variant="destructive"
        loading={deletePanel.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}
