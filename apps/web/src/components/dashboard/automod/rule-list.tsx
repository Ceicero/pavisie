'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { AutomodRuleDto } from '@pavisie/types';
import { Badge, Button, PageHeader, Switch, useToast } from '@pavisie/ui';
import {
  useAutomodRules,
  useDeleteAutomodRule,
  useSetRuleDryRun,
  useUpdateAutomodRule,
} from '@/lib/dashboard/automod-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '../confirm-dialog';
import { DataTable } from '../data-table';
import { RuleFormDialog } from './rule-form-dialog';
import { RULE_TYPE_LABELS } from './rule-type-labels';

export function RuleListTab() {
  const { guildId } = useParams<{ guildId: string }>();
  const { data: rules, isLoading, error, refetch } = useAutomodRules(guildId);
  const updateRule = useUpdateAutomodRule(guildId);
  const setDryRun = useSetRuleDryRun(guildId);
  const deleteRule = useDeleteAutomodRule(guildId);
  const { toast } = useToast();

  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AutomodRuleDto | null>(null);
  const [deleting, setDeleting] = React.useState<AutomodRuleDto | null>(null);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }
  function openEdit(rule: AutomodRuleDto) {
    setEditing(rule);
    setFormOpen(true);
  }

  function toggleEnabled(rule: AutomodRuleDto) {
    updateRule.mutate(
      { ruleId: rule.id, patch: { enabled: !rule.enabled } },
      {
        onError: (err) =>
          toast({
            title: 'Could not update the rule',
            description: err instanceof ApiClientError ? err.message : undefined,
            variant: 'destructive',
          }),
      },
    );
  }

  function toggleDryRun(rule: AutomodRuleDto) {
    setDryRun.mutate(
      { ruleId: rule.id, dryRun: !rule.dryRun },
      {
        onError: (err) =>
          toast({
            title: 'Could not update dry-run',
            description: err instanceof ApiClientError ? err.message : undefined,
            variant: 'destructive',
          }),
      },
    );
  }

  function confirmDelete() {
    if (!deleting) return;
    deleteRule.mutate(deleting.id, {
      onSuccess: () => {
        toast({ title: `Deleted "${deleting.name}"`, variant: 'success' });
        setDeleting(null);
      },
      onError: (err) =>
        toast({
          title: 'Could not delete the rule',
          description: err instanceof ApiClientError ? err.message : undefined,
          variant: 'destructive',
        }),
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Rules"
        description="Every automod rule for this server, evaluated in priority order."
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" /> New rule
          </Button>
        }
      />

      <DataTable
        columns={[
          {
            key: 'name',
            header: 'Rule',
            render: (rule: AutomodRuleDto) => (
              <button
                type="button"
                className="font-medium text-foreground hover:underline"
                onClick={() => openEdit(rule)}
              >
                {rule.name}
              </button>
            ),
          },
          {
            key: 'type',
            header: 'Type',
            render: (rule: AutomodRuleDto) => (
              <Badge variant="outline">
                {RULE_TYPE_LABELS[rule.type as keyof typeof RULE_TYPE_LABELS] ?? rule.type}
              </Badge>
            ),
          },
          {
            key: 'enabled',
            header: 'Enabled',
            render: (rule: AutomodRuleDto) => (
              <Switch
                checked={rule.enabled}
                onCheckedChange={() => toggleEnabled(rule)}
                disabled={updateRule.isPending}
                aria-label="Toggle enabled"
              />
            ),
          },
          {
            key: 'dryRun',
            header: 'Dry-run',
            render: (rule: AutomodRuleDto) => (
              <Switch
                checked={rule.dryRun}
                onCheckedChange={() => toggleDryRun(rule)}
                disabled={setDryRun.isPending}
                aria-label="Toggle dry-run"
              />
            ),
          },
          {
            key: 'actions',
            header: '',
            className: 'text-right',
            render: (rule: AutomodRuleDto) => (
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => openEdit(rule)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setDeleting(rule)}
                >
                  Delete
                </Button>
              </div>
            ),
          },
        ]}
        rows={rules}
        rowKey={(rule) => rule.id}
        loading={isLoading}
        error={error}
        onRetry={() => refetch()}
        emptyTitle="No automod rules yet"
        emptyDescription='Create one with "New rule" to start moderating automatically.'
      />

      <RuleFormDialog guildId={guildId} open={formOpen} onOpenChange={setFormOpen} rule={editing} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete "${deleting?.name}"?`}
        description="This permanently deletes the rule. Its past events stay in the log."
        variant="destructive"
        confirmLabel="Delete"
        loading={deleteRule.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
