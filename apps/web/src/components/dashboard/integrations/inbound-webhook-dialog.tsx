'use client';

import * as React from 'react';
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
  useToast,
} from '@pavisie/ui';
import { ApiClientError } from '@/lib/dashboard/api';
import { useCreateInboundWebhook, type CreateInboundWebhookResult } from '@/lib/dashboard/integrations-queries';
import { DiscordChannelSelect } from '../discord-selects';

export interface InboundWebhookDialogProps {
  guildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (result: CreateInboundWebhookResult) => void;
}

export function InboundWebhookDialog({ guildId, open, onOpenChange, onCreated }: InboundWebhookDialogProps) {
  const [name, setName] = React.useState('');
  const [provider, setProvider] = React.useState<'generic' | 'github'>('generic');
  const [channelId, setChannelId] = React.useState<string | null>(null);
  const [template, setTemplate] = React.useState('');
  const create = useCreateInboundWebhook(guildId);
  const { toast } = useToast();

  React.useEffect(() => {
    if (!open) return;
    setName('');
    setProvider('generic');
    setChannelId(null);
    setTemplate('');
  }, [open]);

  const valid = name.trim().length > 0;

  function handleSubmit() {
    if (!valid) return;
    create.mutate(
      {
        name: name.trim(),
        provider,
        channelId,
        events: provider === 'generic' && template.trim() ? [template.trim()] : [],
      },
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
          <DialogTitle>Create an inbound webhook</DialogTitle>
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

          <FormField label="Source" hint="GitHub events are pre-formatted; generic accepts any JSON payload.">
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as 'generic' | 'github')}
              disabled={create.isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="generic">Generic (any JSON)</SelectItem>
                <SelectItem value="github">GitHub</SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <FormField label="Channel" required>
            <DiscordChannelSelect
              guildId={guildId}
              value={channelId}
              onChange={setChannelId}
              disabled={create.isPending}
            />
          </FormField>

          {provider === 'generic' ? (
            <FormField
              label="Message template"
              hint={
                'Optional. {dot.path} placeholders read from the JSON payload — leave blank for a raw preview.'
              }
            >
              <Input
                value={template}
                maxLength={1500}
                onChange={(e) => setTemplate(e.target.value)}
                disabled={create.isPending}
              />
            </FormField>
          ) : null}
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
