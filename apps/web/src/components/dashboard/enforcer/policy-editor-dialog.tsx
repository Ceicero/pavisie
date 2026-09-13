'use client';

import * as React from 'react';
import type { EnforcerPolicyDto } from '@pavisie/types';
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
  Textarea,
  useToast,
} from '@pavisie/ui';
import { MatcherBuilder } from './matcher-builder';
import { MultiRolePicker } from '../multi-role-picker';
import {
  useCreateEnforcerPolicy,
  useUpdateEnforcerPolicy,
  type EnforcerPolicyInput,
} from '@/lib/dashboard/enforcer-queries';
import { ApiClientError } from '@/lib/dashboard/api';

const SEVERITIES: EnforcerPolicyDto['severity'][] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const SUGGESTED_ACTIONS = ['WARN', 'TIMEOUT', 'MUTE', 'KICK', 'BAN', 'DISMISS'] as const;

function emptyDraft(): EnforcerPolicyInput {
  return {
    name: '',
    description: '',
    enabled: true,
    severity: 'MEDIUM',
    matchers: [{ type: 'keyword', value: '' }],
    channelIds: [],
    exemptRoleIds: [],
    exemptChannelIds: [],
    suggestedAction: null,
  };
}

export interface PolicyEditorDialogProps {
  guildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policy: EnforcerPolicyDto | null;
}

export function PolicyEditorDialog({ guildId, open, onOpenChange, policy }: PolicyEditorDialogProps) {
  const [draft, setDraft] = React.useState<EnforcerPolicyInput>(emptyDraft());
  const create = useCreateEnforcerPolicy(guildId);
  const update = useUpdateEnforcerPolicy(guildId);
  const { toast } = useToast();
  const pending = create.isPending || update.isPending;

  React.useEffect(() => {
    if (open) {
      setDraft(
        policy
          ? {
              name: policy.name,
              description: policy.description,
              enabled: policy.enabled,
              severity: policy.severity,
              matchers: policy.matchers,
              channelIds: policy.channelIds,
              exemptRoleIds: policy.exemptRoleIds,
              exemptChannelIds: policy.exemptChannelIds,
              suggestedAction: policy.suggestedAction,
            }
          : emptyDraft(),
      );
    }
  }, [open, policy]);

  function set<K extends keyof EnforcerPolicyInput>(key: K, value: EnforcerPolicyInput[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    const onError = (err: unknown) =>
      toast({
        title: 'Could not save policy',
        description: err instanceof ApiClientError ? err.message : 'Please try again.',
        variant: 'destructive',
      });
    const onSuccess = () => {
      toast({ title: policy ? 'Policy updated' : 'Policy created', variant: 'success' });
      onOpenChange(false);
    };

    if (policy) {
      update.mutate({ policyId: policy.id, patch: draft }, { onSuccess, onError });
    } else {
      create.mutate(draft, { onSuccess, onError });
    }
  }

  const canSave =
    draft.name.trim().length > 0 && draft.description.trim().length > 0 && draft.matchers.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{policy ? `Edit ${policy.name}` : 'New policy'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Name" required>
            <Input
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              disabled={pending}
              maxLength={100}
            />
          </FormField>
          <FormField
            label="Description"
            required
            hint="Shown to moderators in the flag queue, and to the user when an action is taken."
          >
            <Textarea
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              disabled={pending}
              maxLength={500}
              rows={2}
            />
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Severity">
              <Select
                value={draft.severity}
                onValueChange={(v) => set('severity', v as EnforcerPolicyDto['severity'])}
                disabled={pending}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField
              label="Suggested action"
              hint="Shown in the flag queue as a suggestion — moderators still decide."
            >
              <Select
                value={draft.suggestedAction ?? '__none__'}
                onValueChange={(v) =>
                  set(
                    'suggestedAction',
                    v === '__none__' ? null : (v as EnforcerPolicyDto['suggestedAction']),
                  )
                }
                disabled={pending}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {SUGGESTED_ACTIONS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField
            label="Matchers"
            required
            hint="A message matches this policy if ANY matcher below fires."
          >
            <MatcherBuilder
              matchers={draft.matchers}
              onChange={(v) => set('matchers', v)}
              disabled={pending}
            />
          </FormField>

          <FormField
            label="Exempt roles"
            hint="Members with any of these roles are never flagged by this policy."
          >
            <MultiRolePicker
              guildId={guildId}
              value={draft.exemptRoleIds}
              onChange={(v) => set('exemptRoleIds', v)}
              disabled={pending}
            />
          </FormField>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || pending}>
            {pending ? 'Saving…' : 'Save policy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
