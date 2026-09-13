'use client';

import * as React from 'react';
import { FlaskConical, Pencil, Plus, Trash2 } from 'lucide-react';
import type { EnforcerPolicyDto } from '@pavisie/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  PageHeader,
  Switch,
  useToast,
} from '@pavisie/ui';
import {
  useDeleteEnforcerPolicy,
  useEnforcerPolicies,
  useTestEnforcerPolicy,
  useUpdateEnforcerPolicy,
} from '@/lib/dashboard/enforcer-queries';
import { DataTable, type DataTableColumn } from '../data-table';
import { ConfirmDialog } from '../confirm-dialog';
import { ApiClientError } from '@/lib/dashboard/api';
import { PolicyEditorDialog } from './policy-editor-dialog';

const SEVERITY_BADGE: Record<
  EnforcerPolicyDto['severity'],
  'secondary' | 'default' | 'warning' | 'destructive'
> = {
  LOW: 'secondary',
  MEDIUM: 'default',
  HIGH: 'warning',
  CRITICAL: 'destructive',
};

export interface PoliciesTabProps {
  guildId: string;
}

export function PoliciesTab({ guildId }: PoliciesTabProps) {
  const { data: policies, isLoading, error, refetch } = useEnforcerPolicies(guildId);
  const update = useUpdateEnforcerPolicy(guildId);
  const del = useDeleteEnforcerPolicy(guildId);
  const test = useTestEnforcerPolicy(guildId);
  const { toast } = useToast();

  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editingPolicy, setEditingPolicy] = React.useState<EnforcerPolicyDto | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<EnforcerPolicyDto | null>(null);
  const [testPolicyId, setTestPolicyId] = React.useState<string | null>(null);
  const [testText, setTestText] = React.useState('');

  function openCreate() {
    setEditingPolicy(null);
    setEditorOpen(true);
  }
  function openEdit(policy: EnforcerPolicyDto) {
    setEditingPolicy(policy);
    setEditorOpen(true);
  }
  function toggleEnabled(policy: EnforcerPolicyDto) {
    update.mutate(
      { policyId: policy.id, patch: { enabled: !policy.enabled } },
      {
        onError: (err) =>
          toast({
            title: 'Could not toggle policy',
            description: err instanceof ApiClientError ? err.message : undefined,
            variant: 'destructive',
          }),
      },
    );
  }
  function confirmDelete() {
    if (!deleteTarget) return;
    del.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast({ title: 'Policy deleted', variant: 'success' });
        setDeleteTarget(null);
      },
      onError: (err) =>
        toast({
          title: 'Could not delete policy',
          description: err instanceof ApiClientError ? err.message : undefined,
          variant: 'destructive',
        }),
    });
  }

  const columns: DataTableColumn<EnforcerPolicyDto>[] = [
    {
      key: 'enabled',
      header: 'On',
      render: (p) => (
        <Switch checked={p.enabled} onCheckedChange={() => toggleEnabled(p)} disabled={update.isPending} />
      ),
    },
    { key: 'name', header: 'Name', render: (p) => <span className="font-medium">{p.name}</span> },
    {
      key: 'severity',
      header: 'Severity',
      render: (p) => <Badge variant={SEVERITY_BADGE[p.severity]}>{p.severity}</Badge>,
    },
    {
      key: 'matchers',
      header: 'Matchers',
      render: (p) => `${p.matchers.length} matcher${p.matchers.length === 1 ? '' : 's'}`,
    },
    { key: 'suggestedAction', header: 'Suggested action', render: (p) => p.suggestedAction ?? '—' },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (p) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon" onClick={() => setTestPolicyId(p.id)} aria-label="Test">
            <FlaskConical className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => openEdit(p)} aria-label="Edit">
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setDeleteTarget(p)} aria-label="Delete">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  const testResult = test.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Policies"
        description="What Enforcer looks for, and how severe a match is."
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            New policy
          </Button>
        }
      />

      <DataTable
        columns={columns}
        rows={policies}
        rowKey={(p) => p.id}
        loading={isLoading}
        error={error}
        onRetry={() => refetch()}
        emptyTitle="No policies yet"
        emptyDescription="Create one, or import a starter pack with /enforcer policy import."
      />

      <Card>
        <CardHeader>
          <CardTitle>Test box</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Pick a policy above with the flask icon, then try sample text against it — nothing is flagged.
          </p>
          {testPolicyId ? (
            <div className="flex gap-2">
              <Input
                placeholder="Sample message text…"
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && testText.trim())
                    test.mutate({ policyId: testPolicyId, text: testText });
                }}
              />
              <Button
                onClick={() => test.mutate({ policyId: testPolicyId, text: testText })}
                disabled={!testText.trim() || test.isPending}
              >
                {test.isPending ? 'Testing…' : 'Test'}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No policy selected yet.</p>
          )}
          {testResult ? (
            <div className="rounded-md border border-border p-3 text-sm">
              {testResult.matched ? (
                <ul className="space-y-1">
                  {testResult.matches.map((m, i) => (
                    <li key={i}>
                      <Badge variant="default">Match</Badge> {m.policyName} ({m.severity}) —{' '}
                      {m.matcherSummary}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No match.</p>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <PolicyEditorDialog
        guildId={guildId}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        policy={editingPolicy}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name ?? 'policy'}?`}
        description="This policy will stop matching new messages. Existing ledger records are unaffected."
        variant="destructive"
        loading={del.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
