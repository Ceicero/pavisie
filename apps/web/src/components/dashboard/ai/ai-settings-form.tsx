'use client';

import * as React from 'react';
import { CheckCircle2, KeyRound } from 'lucide-react';
import type { AiProviderId, AiSettingsDto, AiSettingsPatchDto } from '@pavisie/types/ai';
import {
  Badge,
  Button,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  useToast,
} from '@pavisie/ui';
import { useTestAiConnection, useUpdateAiSettings } from '@/lib/dashboard/ai-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ChannelAllowlistPicker } from './channel-allowlist-picker';

const PROVIDERS: { value: AiProviderId; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'compatible', label: 'OpenAI-compatible' },
];

export interface AiSettingsFormProps {
  guildId: string;
  settings: AiSettingsDto;
}

export function AiSettingsForm({ guildId, settings }: AiSettingsFormProps) {
  const update = useUpdateAiSettings(guildId);
  const test = useTestAiConnection(guildId);
  const { toast } = useToast();

  const [draft, setDraft] = React.useState(settings);
  const [apiKeyInput, setApiKeyInput] = React.useState('');

  React.useEffect(() => setDraft(settings), [settings]);

  function set<K extends keyof AiSettingsDto>(key: K, value: AiSettingsDto[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings) || apiKeyInput.trim().length > 0;

  function handleSave() {
    const patch: AiSettingsPatchDto = {
      provider: draft.provider,
      model: draft.model,
      baseUrl: draft.provider === 'compatible' ? draft.baseUrl : null,
      allowEnvKeys: draft.allowEnvKeys,
      allowedChannelIds: draft.allowedChannelIds,
      userCooldownSeconds: draft.userCooldownSeconds,
      dailyTokenBudget: draft.dailyTokenBudget,
      perUserDailyTokenBudget: draft.perUserDailyTokenBudget,
    };
    if (apiKeyInput.trim()) {
      patch.apiKey = apiKeyInput.trim();
    }

    update.mutate(patch, {
      onSuccess: () => {
        setApiKeyInput('');
        toast({ title: 'AI assistant settings saved', variant: 'success' });
      },
      onError: (err) =>
        toast({
          title: 'Could not save settings',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  function handleClearKey() {
    update.mutate(
      { clearKey: true },
      {
        onSuccess: () => toast({ title: 'API key removed', variant: 'success' }),
        onError: (err) =>
          toast({
            title: 'Could not remove key',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  function handleTest() {
    test.mutate(undefined, {
      onSuccess: (result) =>
        toast({
          title: result.ok ? 'Connection queued' : 'Test failed',
          description: result.detail,
          variant: result.ok ? 'success' : 'destructive',
        }),
      onError: (err) =>
        toast({
          title: 'Could not run test',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Provider" htmlFor="ai-provider">
          <Select
            value={draft.provider}
            onValueChange={(v) => set('provider', v as AiProviderId)}
            disabled={update.isPending}
          >
            <SelectTrigger id="ai-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>

        <FormField
          label="Model"
          htmlFor="ai-model"
          hint="Passed through to the provider as-is, e.g. gpt-4o-mini or claude-3-5-sonnet-latest."
        >
          <Input
            id="ai-model"
            value={draft.model}
            onChange={(e) => set('model', e.target.value)}
            disabled={update.isPending}
          />
        </FormField>

        {draft.provider === 'compatible' ? (
          <FormField
            label="Base URL"
            htmlFor="ai-base-url"
            hint="Any OpenAI-chat-completions-shaped API."
            className="sm:col-span-2"
          >
            <Input
              id="ai-base-url"
              value={draft.baseUrl ?? ''}
              placeholder="https://your-llm-host.example.com/v1"
              onChange={(e) => set('baseUrl', e.target.value || null)}
              disabled={update.isPending}
            />
          </FormField>
        ) : null}

        <FormField
          label="API key"
          htmlFor="ai-api-key"
          hint="Write-only — never shown again once saved."
          className="sm:col-span-2"
        >
          <div className="flex items-center gap-2">
            <Input
              id="ai-api-key"
              type="password"
              value={apiKeyInput}
              placeholder={settings.hasKey ? 'Key is set — enter a new one to replace it' : 'sk-...'}
              onChange={(e) => setApiKeyInput(e.target.value)}
              disabled={update.isPending}
              className="flex-1"
            />
            {settings.hasKey ? (
              <Badge variant="secondary" className="shrink-0 gap-1">
                <KeyRound className="h-3 w-3" /> Key set
              </Badge>
            ) : null}
            {settings.hasKey ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleClearKey}
                disabled={update.isPending}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </FormField>

        <FormField
          label="Environment-key fallback"
          htmlFor="ai-allow-env"
          hint="Use OPENAI_API_KEY / ANTHROPIC_API_KEY from the server environment when no key is set above."
        >
          <div className="flex h-9 items-center">
            <Switch
              id="ai-allow-env"
              checked={draft.allowEnvKeys}
              onCheckedChange={(v) => set('allowEnvKeys', v)}
              disabled={update.isPending}
            />
          </div>
        </FormField>

        <FormField label="Per-user cooldown (seconds)" htmlFor="ai-cooldown">
          <Input
            id="ai-cooldown"
            type="number"
            min={0}
            max={3600}
            value={draft.userCooldownSeconds}
            onChange={(e) => set('userCooldownSeconds', Number(e.target.value))}
            disabled={update.isPending}
          />
        </FormField>

        <FormField label="Daily token budget (server)" htmlFor="ai-budget-daily">
          <Input
            id="ai-budget-daily"
            type="number"
            min={1000}
            max={10_000_000}
            value={draft.dailyTokenBudget}
            onChange={(e) => set('dailyTokenBudget', Number(e.target.value))}
            disabled={update.isPending}
          />
        </FormField>

        <FormField label="Daily token budget (per user)" htmlFor="ai-budget-user">
          <Input
            id="ai-budget-user"
            type="number"
            min={100}
            max={1_000_000}
            value={draft.perUserDailyTokenBudget}
            onChange={(e) => set('perUserDailyTokenBudget', Number(e.target.value))}
            disabled={update.isPending}
          />
        </FormField>

        <FormField
          label="Allowed channels (/ask, /summarize)"
          hint="Empty = both commands stay off. /draft and /mod-assist are staff-only and work anywhere."
          className="sm:col-span-2"
        >
          <ChannelAllowlistPicker
            guildId={guildId}
            value={draft.allowedChannelIds}
            onChange={(v) => set('allowedChannelIds', v)}
            disabled={update.isPending}
          />
        </FormField>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button onClick={handleSave} disabled={!dirty || update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" variant="outline" onClick={handleTest} disabled={test.isPending}>
          {test.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        {test.data ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {test.data.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : null}
            {test.data.detail}
          </span>
        ) : null}
      </div>
    </div>
  );
}
