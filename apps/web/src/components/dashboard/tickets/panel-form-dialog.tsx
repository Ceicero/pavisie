'use client';

import * as React from 'react';
import type { TicketIntakeFieldDto, TicketPanelDto } from '@pavisie/types/tickets';
import {
  Button,
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
  Switch,
  Textarea,
  useToast,
} from '@pavisie/ui';
import { ApiClientError } from '@/lib/dashboard/api';
import {
  useCreateTicketPanel,
  useTicketSettings,
  useUpdateTicketPanel,
  type CreateTicketPanelInput,
} from '@/lib/dashboard/tickets-queries';
import { DiscordChannelSelect } from '../discord-selects';
import { MultiRolePicker } from '../multi-role-picker';
import { IntakeFormBuilder } from './intake-form-builder';

export interface PanelFormDialogProps {
  guildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, edits this panel instead of creating a new one. */
  panel?: TicketPanelDto;
}

type Draft = CreateTicketPanelInput & { intakeForm: TicketIntakeFieldDto[] | null };

const EMPTY: Draft = {
  channelId: '',
  title: '',
  description: '',
  buttonLabel: 'Open a ticket',
  categoryId: null,
  supportRoleIds: [],
  mode: 'CHANNEL',
  slaMinutes: null,
  intakeForm: null,
};

export function PanelFormDialog({ guildId, open, onOpenChange, panel }: PanelFormDialogProps) {
  const [draft, setDraft] = React.useState<Draft>(EMPTY);
  const create = useCreateTicketPanel(guildId);
  const update = useUpdateTicketPanel(guildId);
  const { data: settings } = useTicketSettings(guildId);
  const { toast } = useToast();
  const pending = create.isPending || update.isPending;

  React.useEffect(() => {
    if (!open) return;
    setDraft(
      panel
        ? {
            channelId: panel.channelId,
            title: panel.title,
            description: panel.description,
            buttonLabel: panel.buttonLabel,
            categoryId: panel.categoryId,
            supportRoleIds: panel.supportRoleIds,
            mode: panel.mode,
            slaMinutes: panel.slaMinutes,
            intakeForm: panel.intakeForm,
          }
        : EMPTY,
    );
  }, [open, panel]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  const valid =
    draft.channelId.length > 0 && draft.title.trim().length > 0 && draft.description.trim().length > 0;

  function handleSubmit() {
    if (!valid) return;
    const onError = (err: unknown) =>
      toast({
        title: `Could not ${panel ? 'update' : 'create'} panel`,
        description: err instanceof ApiClientError ? err.message : 'Please try again.',
        variant: 'destructive',
      });
    const onSuccess = () => {
      toast({ title: panel ? 'Panel updated' : 'Panel created', variant: 'success' });
      onOpenChange(false);
    };

    if (panel) {
      update.mutate({ panelId: panel.id, patch: draft }, { onSuccess, onError });
    } else {
      create.mutate(draft, { onSuccess, onError });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{panel ? 'Edit ticket panel' : 'Create a ticket panel'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Title" required>
            <Input
              value={draft.title}
              maxLength={100}
              onChange={(e) => set('title', e.target.value)}
              disabled={pending}
            />
          </FormField>
          <FormField label="Description" required>
            <Textarea
              value={draft.description}
              maxLength={2000}
              rows={4}
              onChange={(e) => set('description', e.target.value)}
              disabled={pending}
            />
          </FormField>
          <FormField label="Button label">
            <Input
              value={draft.buttonLabel}
              maxLength={80}
              onChange={(e) => set('buttonLabel', e.target.value)}
              disabled={pending}
            />
          </FormField>
          <FormField label="Channel to post in" required>
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.channelId || null}
              onChange={(v) => set('channelId', v ?? '')}
              disabled={pending}
            />
          </FormField>
          <FormField label="Ticket mode">
            <Select
              value={draft.mode}
              onValueChange={(v) => set('mode', v as CreateTicketPanelInput['mode'])}
              disabled={pending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CHANNEL">Private channel</SelectItem>
                <SelectItem value="THREAD">Private thread</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          {draft.mode === 'CHANNEL' ? (
            <FormField label="Category" hint="New ticket channels are created under this category.">
              <DiscordChannelSelect
                guildId={guildId}
                value={draft.categoryId ?? null}
                onChange={(v) => set('categoryId', v)}
                disabled={pending}
                kinds={['category']}
              />
            </FormField>
          ) : null}
          <FormField
            label="Support roles"
            hint="Up to 3. Overrides the server default for tickets opened from this panel."
          >
            <MultiRolePicker
              guildId={guildId}
              value={draft.supportRoleIds}
              onChange={(v) => set('supportRoleIds', v.slice(0, 3))}
              disabled={pending}
            />
          </FormField>
          <FormField label="SLA override (minutes)" hint="Blank uses the server default.">
            <Input
              type="number"
              min={1}
              value={draft.slaMinutes ?? ''}
              placeholder="Server default"
              disabled={pending}
              onChange={(e) => set('slaMinutes', e.target.value === '' ? null : Number(e.target.value))}
            />
          </FormField>
          <FormField label="Intake form">
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium">Ask questions before opening</p>
                <p className="text-xs text-muted-foreground">
                  Shows a modal for the answers below when someone clicks the panel button.
                </p>
              </div>
              <Switch
                checked={draft.intakeForm !== null}
                onCheckedChange={(v) =>
                  set(
                    'intakeForm',
                    v
                      ? (draft.intakeForm ??
                          settings?.intakeForm ?? [{ label: '', style: 'short', required: true }])
                      : null,
                  )
                }
                disabled={pending}
              />
            </div>
            {draft.intakeForm !== null ? (
              <div className="mt-3">
                <IntakeFormBuilder
                  value={draft.intakeForm}
                  onChange={(v) => set('intakeForm', v)}
                  disabled={pending}
                />
              </div>
            ) : null}
          </FormField>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!valid || pending}>
            {pending ? 'Saving…' : panel ? 'Save changes' : 'Create panel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
