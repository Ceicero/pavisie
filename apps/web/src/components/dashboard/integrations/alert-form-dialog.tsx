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
import type { AlertProviderId } from '@pavisie/types/integrations';
import { ApiClientError } from '@/lib/dashboard/api';
import { useCreateAlertConnection } from '@/lib/dashboard/integrations-queries';
import { DiscordChannelSelect, DiscordRoleSelect } from '../discord-selects';

const PROVIDER_LABELS: Record<
  AlertProviderId,
  { label: string; targetLabel: string; targetPlaceholder: string }
> = {
  twitch: { label: 'Twitch', targetLabel: 'Twitch login', targetPlaceholder: 'shroud' },
  youtube: { label: 'YouTube', targetLabel: 'Channel ID', targetPlaceholder: 'UCxxxxxxxxxxxxxxxxxxxxxx' },
  reddit: { label: 'Reddit', targetLabel: 'Subreddit', targetPlaceholder: 'gaming' },
  steam: { label: 'Steam', targetLabel: 'App ID', targetPlaceholder: '730' },
};

export interface AlertFormDialogProps {
  guildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselects and locks the provider (opened from a specific provider card). */
  provider?: AlertProviderId;
}

export function AlertFormDialog({ guildId, open, onOpenChange, provider }: AlertFormDialogProps) {
  const [selectedProvider, setSelectedProvider] = React.useState<AlertProviderId>(provider ?? 'twitch');
  const [target, setTarget] = React.useState('');
  const [channelId, setChannelId] = React.useState<string | null>(null);
  const [roleId, setRoleId] = React.useState<string | null>(null);
  const [template, setTemplate] = React.useState('');
  const create = useCreateAlertConnection(guildId);
  const { toast } = useToast();

  React.useEffect(() => {
    if (!open) return;
    setSelectedProvider(provider ?? 'twitch');
    setTarget('');
    setChannelId(null);
    setRoleId(null);
    setTemplate('');
  }, [open, provider]);

  const meta = PROVIDER_LABELS[selectedProvider];
  const valid = target.trim().length > 0 && Boolean(channelId);

  function handleSubmit() {
    if (!valid || !channelId) return;
    create.mutate(
      {
        provider: selectedProvider,
        target: target.trim(),
        channelId,
        roleId,
        template: template.trim() || null,
      },
      {
        onSuccess: () => {
          toast({ title: 'Alert watch added', variant: 'success' });
          onOpenChange(false);
        },
        onError: (err) =>
          toast({
            title: 'Could not add alert watch',
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
          <DialogTitle>Add an alert watch</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Provider" required>
            <Select
              value={selectedProvider}
              onValueChange={(v) => setSelectedProvider(v as AlertProviderId)}
              disabled={create.isPending || Boolean(provider)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PROVIDER_LABELS) as AlertProviderId[]).map((id) => (
                  <SelectItem key={id} value={id}>
                    {PROVIDER_LABELS[id].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField label={meta.targetLabel} required>
            <Input
              value={target}
              placeholder={meta.targetPlaceholder}
              onChange={(e) => setTarget(e.target.value)}
              disabled={create.isPending}
            />
          </FormField>

          <FormField label="Alert channel" required>
            <DiscordChannelSelect
              guildId={guildId}
              value={channelId}
              onChange={setChannelId}
              disabled={create.isPending}
            />
          </FormField>

          <FormField label="Mention role" hint="Optional — pinged in the alert message.">
            <DiscordRoleSelect
              guildId={guildId}
              value={roleId}
              onChange={setRoleId}
              disabled={create.isPending}
            />
          </FormField>

          <FormField label="Custom message" hint="Optional. Leave blank for the default wording.">
            <Input
              value={template}
              maxLength={300}
              onChange={(e) => setTemplate(e.target.value)}
              disabled={create.isPending}
            />
          </FormField>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!valid || create.isPending}>
            {create.isPending ? 'Adding…' : 'Add watch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
