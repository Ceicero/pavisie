'use client';

import * as React from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
  Label,
  useToast,
} from '@pavisie/ui';
import type { OutboundPlatformEvent } from '@pavisie/types/integrations';
import { ApiClientError } from '@/lib/dashboard/api';
import { useCreateOutboundWebhook, type CreateOutboundWebhookResult } from '@/lib/dashboard/integrations-queries';

const EVENT_OPTIONS: { value: OutboundPlatformEvent; label: string }[] = [
  { value: 'moderation.caseCreated', label: 'Moderation case created' },
  { value: 'ticket.opened', label: 'Ticket opened' },
  { value: 'ticket.closed', label: 'Ticket closed' },
  { value: 'member.verified', label: 'Member verified' },
  { value: 'level.up', label: 'Level up' },
  { value: 'automod.triggered', label: 'Automod triggered' },
  { value: 'enforcer.decided', label: 'Enforcer decision' },
];

export interface OutboundWebhookDialogProps {
  guildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (result: CreateOutboundWebhookResult) => void;
}

export function OutboundWebhookDialog({
  guildId,
  open,
  onOpenChange,
  onCreated,
}: OutboundWebhookDialogProps) {
  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [events, setEvents] = React.useState<OutboundPlatformEvent[]>([]);
  const create = useCreateOutboundWebhook(guildId);
  const { toast } = useToast();

  React.useEffect(() => {
    if (!open) return;
    setName('');
    setUrl('');
    setEvents([]);
  }, [open]);

  function toggleEvent(value: OutboundPlatformEvent, checked: boolean) {
    setEvents((prev) => (checked ? [...prev, value] : prev.filter((e) => e !== value)));
  }

  const valid = name.trim().length > 0 && url.trim().length > 0 && events.length > 0;

  function handleSubmit() {
    if (!valid) return;
    create.mutate(
      { name: name.trim(), url: url.trim(), events },
      {
        onSuccess: (result) => {
          onOpenChange(false);
          onCreated(result);
        },
        onError: (err) =>
          toast({
            title: 'Could not create webhook',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an outbound webhook</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Name" required>
            <Input
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              disabled={create.isPending}
            />
          </FormField>

          <FormField
            label="URL"
            required
            hint="Must be a public HTTPS URL — private/internal addresses are rejected."
          >
            <Input
              value={url}
              type="url"
              placeholder="https://example.com/webhook"
              onChange={(e) => setUrl(e.target.value)}
              disabled={create.isPending}
            />
          </FormField>

          <FormField label="Events" required>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {EVENT_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={events.includes(opt.value)}
                    onCheckedChange={(checked) => toggleEvent(opt.value, checked === true)}
                    disabled={create.isPending}
                  />
                  <Label className="font-normal">{opt.label}</Label>
                </label>
              ))}
            </div>
          </FormField>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!valid || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
