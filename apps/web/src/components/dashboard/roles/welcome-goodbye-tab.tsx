'use client';

import * as React from 'react';
import type { WelcomeGoodbyeDto } from '@pavisie/types/roles';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmbedPreview,
  FormField,
  Input,
  Skeleton,
  Switch,
  Textarea,
  useToast,
} from '@pavisie/ui';
import {
  useGoodbyeConfig,
  useTestGoodbye,
  useTestWelcome,
  useUpdateGoodbyeConfig,
  useUpdateWelcomeConfig,
  useWelcomeConfig,
  type WelcomeGoodbyePatch,
} from '@/lib/dashboard/roles-queries';
import { DiscordChannelSelect } from '../discord-selects';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';

const VARS_HINT = 'Vars: {user} {user.tag} {user.id} {server} {memberCount} {mention}';

interface SectionEditorProps {
  guildId: string;
  label: string;
  data: WelcomeGoodbyeDto | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  onSave: (patch: WelcomeGoodbyePatch) => void;
  saving: boolean;
  onTest: (channelId?: string) => void;
  testing: boolean;
}

function SectionEditor({
  guildId,
  label,
  data,
  isLoading,
  error,
  onRetry,
  onSave,
  saving,
  onTest,
  testing,
}: SectionEditorProps) {
  const [draft, setDraft] = React.useState<WelcomeGoodbyeDto | null>(null);
  const [embedTitle, setEmbedTitle] = React.useState('');
  const [embedDescription, setEmbedDescription] = React.useState('');
  const [embedColor, setEmbedColor] = React.useState('#e5e5e5');
  const [embedFooter, setEmbedFooter] = React.useState('');

  React.useEffect(() => {
    if (!data) return;
    setDraft(data);
    const embed = (data.embed ?? {}) as {
      title?: string;
      description?: string;
      color?: string;
      footer?: { text?: string };
    };
    setEmbedTitle(embed.title ?? '');
    setEmbedDescription(embed.description ?? '');
    setEmbedColor(embed.color ?? '#e5e5e5');
    setEmbedFooter(embed.footer?.text ?? '');
  }, [data]);

  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (isLoading || !draft) return <Skeleton className="h-72 w-full" />;

  const hasEmbed = Boolean(embedTitle || embedDescription);
  const previewVars = {
    user: 'ExampleUser',
    'user.tag': 'ExampleUser',
    server: 'Your Server',
    memberCount: '128',
  };
  const renderVars = (s: string) =>
    s.replace(/\{(\w+(\.\w+)?)\}/g, (m, key) => (previewVars as Record<string, string>)[key] ?? m);

  function handleSave() {
    onSave({
      enabled: draft!.enabled,
      channelId: draft!.channelId,
      message: draft!.message,
      dm: draft!.dm,
      embed: hasEmbed
        ? {
            ...(embedTitle ? { title: embedTitle } : {}),
            ...(embedDescription ? { description: embedDescription } : {}),
            color: embedColor,
            ...(embedFooter ? { footer: { text: embedFooter } } : {}),
          }
        : null,
    });
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{label}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <p className="text-sm font-medium">Enabled</p>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => setDraft((p) => ({ ...p!, enabled: v }))}
            />
          </div>

          <FormField label="Channel">
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.channelId}
              onChange={(v) => setDraft((p) => ({ ...p!, channelId: v }))}
            />
          </FormField>

          <FormField label="Message" hint={VARS_HINT}>
            <Textarea
              value={draft.message ?? ''}
              onChange={(e) => setDraft((p) => ({ ...p!, message: e.target.value || null }))}
              rows={3}
              maxLength={2000}
            />
          </FormField>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <p className="text-sm font-medium">Also DM the member</p>
            <Switch checked={draft.dm} onCheckedChange={(v) => setDraft((p) => ({ ...p!, dm: v }))} />
          </div>

          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="text-sm font-medium">Embed (optional)</p>
            <FormField label="Title">
              <Input value={embedTitle} onChange={(e) => setEmbedTitle(e.target.value)} maxLength={256} />
            </FormField>
            <FormField label="Description" hint={VARS_HINT}>
              <Textarea
                value={embedDescription}
                onChange={(e) => setEmbedDescription(e.target.value)}
                rows={2}
                maxLength={2000}
              />
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Color">
                <Input
                  type="color"
                  value={embedColor}
                  onChange={(e) => setEmbedColor(e.target.value)}
                  className="h-9 w-full"
                />
              </FormField>
              <FormField label="Footer">
                <Input value={embedFooter} onChange={(e) => setEmbedFooter(e.target.value)} maxLength={256} />
              </FormField>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onTest(draft.channelId ?? undefined)} disabled={testing}>
              {testing ? 'Sending…' : 'Send test'}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Live preview</CardTitle>
        </CardHeader>
        <CardContent>
          <EmbedPreview
            content={draft.message ? renderVars(draft.message) : undefined}
            embed={
              hasEmbed
                ? {
                    title: embedTitle ? renderVars(embedTitle) : undefined,
                    description: embedDescription ? renderVars(embedDescription) : undefined,
                    color: embedColor,
                    footer: embedFooter ? { text: embedFooter } : undefined,
                  }
                : { description: '_Nothing configured yet._' }
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}

export function WelcomeGoodbyeTab({ guildId }: { guildId: string }) {
  const welcome = useWelcomeConfig(guildId);
  const goodbye = useGoodbyeConfig(guildId);
  const updateWelcome = useUpdateWelcomeConfig(guildId);
  const updateGoodbye = useUpdateGoodbyeConfig(guildId);
  const testWelcome = useTestWelcome(guildId);
  const testGoodbye = useTestGoodbye(guildId);
  const { toast } = useToast();

  return (
    <div className="space-y-8">
      <SectionEditor
        guildId={guildId}
        label="Welcome message"
        data={welcome.data}
        isLoading={welcome.isLoading}
        error={welcome.error}
        onRetry={() => welcome.refetch()}
        saving={updateWelcome.isPending}
        testing={testWelcome.isPending}
        onSave={(patch) =>
          updateWelcome.mutate(patch, {
            onSuccess: () => toast({ title: 'Welcome message saved', variant: 'success' }),
            onError: (err) =>
              toast({
                title: 'Could not save',
                description: err instanceof ApiClientError ? err.message : undefined,
                variant: 'destructive',
              }),
          })
        }
        onTest={(channelId) =>
          testWelcome.mutate(channelId, {
            onSuccess: () => toast({ title: 'Test queued', variant: 'success' }),
            onError: (err) =>
              toast({
                title: 'Could not send test',
                description: err instanceof ApiClientError ? err.message : undefined,
                variant: 'destructive',
              }),
          })
        }
      />

      <SectionEditor
        guildId={guildId}
        label="Goodbye message"
        data={goodbye.data}
        isLoading={goodbye.isLoading}
        error={goodbye.error}
        onRetry={() => goodbye.refetch()}
        saving={updateGoodbye.isPending}
        testing={testGoodbye.isPending}
        onSave={(patch) =>
          updateGoodbye.mutate(patch, {
            onSuccess: () => toast({ title: 'Goodbye message saved', variant: 'success' }),
            onError: (err) =>
              toast({
                title: 'Could not save',
                description: err instanceof ApiClientError ? err.message : undefined,
                variant: 'destructive',
              }),
          })
        }
        onTest={(channelId) =>
          testGoodbye.mutate(channelId, {
            onSuccess: () => toast({ title: 'Test queued', variant: 'success' }),
            onError: (err) =>
              toast({
                title: 'Could not send test',
                description: err instanceof ApiClientError ? err.message : undefined,
                variant: 'destructive',
              }),
          })
        }
      />
    </div>
  );
}
