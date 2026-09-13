'use client';

import * as React from 'react';
import type { AutomodRuleDto } from '@pavisie/types';
import type { AutomodActionInput, AutomodRuleTypeValue } from '@pavisie/types/automod';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast,
} from '@pavisie/ui';
import { useCreateAutomodRule, useTestAutomodRule, useUpdateAutomodRule } from '@/lib/dashboard/automod-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { MultiRolePicker } from '../multi-role-picker';
import { MultiChannelPicker } from './multi-channel-picker';
import { RuleActionsEditor } from './rule-actions-editor';
import { RuleConfigFields } from './rule-config-fields';
import { RULE_TYPE_LABELS } from './rule-type-labels';
import { TagInput } from './tag-input';

export interface RuleFormDialogProps {
  guildId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing an existing rule; omitted when creating a new one. */
  rule?: AutomodRuleDto | null;
}

interface DraftState {
  name: string;
  type: AutomodRuleTypeValue;
  enabled: boolean;
  dryRun: boolean;
  config: Record<string, unknown>;
  actions: AutomodActionInput[];
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  exemptUserIds: string[];
  trustedDomains: string[];
  cooldownSeconds: number;
  priority: number;
}

function draftFromRule(rule: AutomodRuleDto | null | undefined): DraftState {
  if (!rule) {
    return {
      name: '',
      type: 'MESSAGE_FREQUENCY',
      enabled: true,
      dryRun: true,
      config: { type: 'MESSAGE_FREQUENCY' },
      actions: [{ type: 'warn' }],
      exemptRoleIds: [],
      exemptChannelIds: [],
      exemptUserIds: [],
      trustedDomains: [],
      cooldownSeconds: 0,
      priority: 0,
    };
  }
  return {
    name: rule.name,
    type: rule.type as AutomodRuleTypeValue,
    enabled: rule.enabled,
    dryRun: rule.dryRun,
    config: rule.config ?? { type: rule.type },
    actions: (rule.actions ?? []) as unknown as AutomodActionInput[],
    exemptRoleIds: rule.exemptRoleIds,
    exemptChannelIds: rule.exemptChannelIds,
    exemptUserIds: rule.exemptUserIds,
    trustedDomains: rule.trustedDomains ?? [],
    cooldownSeconds: rule.cooldownSeconds ?? 0,
    priority: rule.priority ?? 0,
  };
}

/** Create/edit dialog for an automod rule: type + name, type-driven config fields, an actions builder, and an exemptions editor (TASK: "create/edit form driven by the rule type ... actions builder, exemptions editor"). */
export function RuleFormDialog({ guildId, open, onOpenChange, rule }: RuleFormDialogProps) {
  const isEdit = Boolean(rule);
  const [draft, setDraft] = React.useState<DraftState>(() => draftFromRule(rule));
  const [testText, setTestText] = React.useState('');
  const [testResult, setTestResult] = React.useState<{ matched: boolean; reason?: string } | null>(null);

  React.useEffect(() => {
    if (open) {
      setDraft(draftFromRule(rule));
      setTestResult(null);
      setTestText('');
    }
    // Intentionally re-seeds only when the dialog opens or its target rule changes.
  }, [open, rule?.id]);

  const createRule = useCreateAutomodRule(guildId);
  const updateRule = useUpdateAutomodRule(guildId);
  const testRule = useTestAutomodRule(guildId);
  const { toast } = useToast();

  const saving = createRule.isPending || updateRule.isPending;

  function set<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleTypeChange(nextType: AutomodRuleTypeValue) {
    setDraft((prev) => ({ ...prev, type: nextType, config: { type: nextType } }));
  }

  function handleSave() {
    if (draft.name.trim().length === 0) {
      toast({ title: 'Name is required', variant: 'destructive' });
      return;
    }
    if (draft.actions.length === 0) {
      toast({ title: 'At least one action is required', variant: 'destructive' });
      return;
    }

    const payload = {
      name: draft.name.trim(),
      enabled: draft.enabled,
      dryRun: draft.dryRun,
      config: { ...draft.config, type: draft.type },
      actions: draft.actions,
      exemptRoleIds: draft.exemptRoleIds,
      exemptChannelIds: draft.exemptChannelIds,
      exemptUserIds: draft.exemptUserIds,
      trustedDomains: draft.trustedDomains,
      cooldownSeconds: draft.cooldownSeconds,
      priority: draft.priority,
    };

    const onSuccess = () => {
      toast({ title: isEdit ? 'Rule updated' : 'Rule created', variant: 'success' });
      onOpenChange(false);
    };
    const onError = (err: unknown) =>
      toast({
        title: 'Could not save the rule',
        description: err instanceof ApiClientError ? err.message : 'Please try again.',
        variant: 'destructive',
      });

    if (isEdit && rule) {
      updateRule.mutate({ ruleId: rule.id, patch: payload }, { onSuccess, onError });
    } else {
      createRule.mutate(payload, { onSuccess, onError });
    }
  }

  function handleTest() {
    if (!rule) return;
    testRule.mutate(
      { ruleId: rule.id, text: testText },
      {
        onSuccess: (result) => setTestResult(result),
        onError: (err) =>
          toast({
            title: 'Test failed',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit rule: ${rule?.name}` : 'New automod rule'}</DialogTitle>
          <DialogDescription>
            Rules are enabled with dry-run on by default — matches are logged but nothing happens until you
            turn dry-run off.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="config">
          <TabsList>
            <TabsTrigger value="config">Configuration</TabsTrigger>
            <TabsTrigger value="exemptions">Exemptions</TabsTrigger>
            {isEdit ? <TabsTrigger value="test">Test</TabsTrigger> : null}
          </TabsList>

          <TabsContent value="config" className="space-y-4">
            <FormField label="Name" required>
              <Input
                value={draft.name}
                onChange={(e) => set('name', e.target.value)}
                maxLength={100}
                disabled={saving}
              />
            </FormField>

            <FormField
              label="Type"
              hint={
                isEdit
                  ? "A rule's type can't be changed after creation — delete and recreate it instead."
                  : undefined
              }
            >
              <Select
                value={draft.type}
                onValueChange={(v) => handleTypeChange(v as AutomodRuleTypeValue)}
                disabled={saving || isEdit}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(RULE_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <RuleConfigFields
                type={draft.type}
                config={draft.config}
                onChange={(c) => set('config', c)}
                disabled={saving}
              />
            </div>

            <FormField label="Actions" hint="Applied in order when the rule matches and dry-run is off.">
              <RuleActionsEditor
                actions={draft.actions}
                onChange={(a) => set('actions', a)}
                disabled={saving}
              />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <p className="text-sm font-medium">Enabled</p>
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(v) => set('enabled', v)}
                  disabled={saving}
                />
              </div>
              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <p className="text-sm font-medium">Dry-run</p>
                <Switch checked={draft.dryRun} onCheckedChange={(v) => set('dryRun', v)} disabled={saving} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Cooldown (seconds)" hint="Per user, per rule. 0 = no cooldown.">
                <Input
                  type="number"
                  min={0}
                  value={draft.cooldownSeconds}
                  onChange={(e) => set('cooldownSeconds', Number(e.target.value) || 0)}
                  disabled={saving}
                />
              </FormField>
              <FormField label="Priority" hint="Lower runs first.">
                <Input
                  type="number"
                  min={0}
                  value={draft.priority}
                  onChange={(e) => set('priority', Number(e.target.value) || 0)}
                  disabled={saving}
                />
              </FormField>
            </div>
          </TabsContent>

          <TabsContent value="exemptions" className="space-y-4">
            <FormField label="Exempt roles">
              <MultiRolePicker
                guildId={guildId}
                value={draft.exemptRoleIds}
                onChange={(v) => set('exemptRoleIds', v)}
                disabled={saving}
              />
            </FormField>
            <FormField label="Exempt channels">
              <MultiChannelPicker
                guildId={guildId}
                value={draft.exemptChannelIds}
                onChange={(v) => set('exemptChannelIds', v)}
                disabled={saving}
                kinds={['text', 'announcement', 'forum', 'voice']}
              />
            </FormField>
            <FormField label="Exempt users" hint="Discord user IDs">
              <TagInput
                value={draft.exemptUserIds}
                onChange={(v) => set('exemptUserIds', v)}
                disabled={saving}
                placeholder="Paste a user ID and press Enter"
              />
            </FormField>
            <FormField
              label="Trusted domains"
              hint="Link-based rules (scam links, etc.) never flag these domains."
            >
              <TagInput
                value={draft.trustedDomains}
                onChange={(v) => set('trustedDomains', v)}
                disabled={saving}
              />
            </FormField>
          </TabsContent>

          {isEdit ? (
            <TabsContent value="test" className="space-y-3">
              <FormField
                label="Sample text"
                hint="Runs this rule's evaluator against the text below — no action is taken."
              >
                <Textarea value={testText} onChange={(e) => setTestText(e.target.value)} rows={4} />
              </FormField>
              <Button
                type="button"
                variant="outline"
                onClick={handleTest}
                disabled={testRule.isPending || testText.trim().length === 0}
              >
                {testRule.isPending ? 'Testing…' : 'Run test'}
              </Button>
              {testResult ? (
                <div
                  className={`rounded-md border p-3 text-sm ${testResult.matched ? 'border-destructive text-destructive' : 'border-border text-muted-foreground'}`}
                >
                  {testResult.matched ? 'Matched.' : 'No match.'} {testResult.reason ?? ''}
                </div>
              ) : null}
            </TabsContent>
          ) : null}
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
