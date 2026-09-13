'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  Input,
  Skeleton,
  Textarea,
  useToast,
} from '@entrophy/ui';
import { useOnboardingConfig, useUpdateOnboardingConfig } from '@/lib/dashboard/roles-queries';
import { DiscordRoleSelect } from '../discord-selects';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';

export function OnboardingTab({ guildId }: { guildId: string }) {
  const { data, isLoading, error, refetch } = useOnboardingConfig(guildId);
  const update = useUpdateOnboardingConfig(guildId);
  const { toast } = useToast();

  const [rulesText, setRulesText] = React.useState('');
  const [rulesRoleId, setRulesRoleId] = React.useState<string | null>(null);
  const [steps, setSteps] = React.useState<{ id: string; label: string }[]>([]);

  React.useEffect(() => {
    if (!data) return;
    setRulesText(data.rulesText ?? '');
    setRulesRoleId(data.rulesRoleId);
    setSteps(data.steps);
  }, [data]);

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading) return <Skeleton className="h-96 w-full" />;

  function handleSave() {
    update.mutate(
      { rulesText: rulesText || null, rulesRoleId, steps },
      {
        onSuccess: () => toast({ title: 'Onboarding configuration saved', variant: 'success' }),
        onError: (err) =>
          toast({
            title: 'Could not save',
            description: err instanceof ApiClientError ? err.message : undefined,
            variant: 'destructive',
          }),
      },
    );
  }

  function addStep() {
    setSteps((prev) => [...prev, { id: `step${prev.length + 1}`, label: '' }]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rules &amp; checklist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField label="Rules text" hint="Posted with an “I agree” button via /onboarding rules-post.">
          <Textarea
            value={rulesText}
            onChange={(e) => setRulesText(e.target.value)}
            rows={6}
            maxLength={4000}
          />
        </FormField>

        <FormField label="Role granted on agreement (optional)">
          <DiscordRoleSelect guildId={guildId} value={rulesRoleId} onChange={setRulesRoleId} />
        </FormField>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Custom checklist steps</p>
            <Button size="sm" variant="outline" onClick={addStep} disabled={steps.length >= 20}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add step
            </Button>
          </div>
          {steps.map((step, i) => (
            <div key={i} className="flex gap-2">
              <Input
                value={step.id}
                placeholder="id"
                className="w-32"
                onChange={(e) =>
                  setSteps((prev) => prev.map((s, si) => (si === i ? { ...s, id: e.target.value } : s)))
                }
              />
              <Input
                value={step.label}
                placeholder="Label shown to the member"
                className="flex-1"
                onChange={(e) =>
                  setSteps((prev) => prev.map((s, si) => (si === i ? { ...s, label: e.target.value } : s)))
                }
              />
              <Button
                variant="outline"
                size="icon"
                aria-label="Remove step"
                onClick={() => setSteps((prev) => prev.filter((_, si) => si !== i))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
