'use client';

import * as React from 'react';
import type { AiChatSettingsDto, AiSettingsDto } from '@pavisie/types/ai';
import { Button, FormField, Input, Switch, Textarea, useToast } from '@pavisie/ui';
import { useUpdateAiSettings } from '@/lib/dashboard/ai-queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ChannelAllowlistPicker } from './channel-allowlist-picker';

const PERSONA_MAX_LENGTH = 1500;
const DEFAULT_PERSONA_PLACEHOLDER = 'Default: "Helpful, upbeat gaming-community assistant."';

export interface MentionChatFormProps {
  guildId: string;
  settings: AiSettingsDto;
}

/** The AI page's "Mention chat" card: members talk to the bot by @mentioning it in these channels. Saves independently of the rest of the AI settings form — same `PUT /guilds/:guildId/ai/settings` endpoint, just a `chat` patch. */
export function MentionChatForm({ guildId, settings }: MentionChatFormProps) {
  const update = useUpdateAiSettings(guildId);
  const { toast } = useToast();

  const [draft, setDraft] = React.useState<AiChatSettingsDto>(settings.chat);
  React.useEffect(() => setDraft(settings.chat), [settings.chat]);

  function set<K extends keyof AiChatSettingsDto>(key: K, value: AiChatSettingsDto[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.chat);

  function handleSave() {
    // `persona: ''` isn't a valid value (schema requires 1-1500 chars or null) — an empty textarea means
    // "use the default", same as clearing it.
    const patch: AiChatSettingsDto = {
      ...draft,
      persona: draft.persona?.trim() ? draft.persona.trim() : null,
    };
    update.mutate(
      { chat: patch },
      {
        onSuccess: () => toast({ title: 'Mention-chat settings saved', variant: 'success' }),
        onError: (err) =>
          toast({
            title: 'Could not save mention-chat settings',
            description: err instanceof ApiClientError ? err.message : 'Please try again.',
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <div className="space-y-4">
      <FormField
        label="Enable mention chat"
        htmlFor="chat-enabled"
        hint="The bot only replies when @mentioned in the channels below — never passively, and never just because a message replies to it."
      >
        <div className="flex h-9 items-center">
          <Switch
            id="chat-enabled"
            checked={draft.enabled}
            onCheckedChange={(v) => set('enabled', v)}
            disabled={update.isPending}
          />
        </div>
      </FormField>

      <FormField
        label="Channels"
        hint="Empty = mention chat never triggers, even while enabled. Max 20 channels."
      >
        <ChannelAllowlistPicker
          guildId={guildId}
          value={draft.channelIds}
          onChange={(v) => set('channelIds', v)}
          disabled={update.isPending}
          kinds={['text']}
        />
      </FormField>

      <FormField
        label={`Persona (${(draft.persona ?? '').length}/${PERSONA_MAX_LENGTH})`}
        htmlFor="chat-persona"
        hint="Tone and name only — safety rules (no harmful/illegal/NSFW content, can't take moderation actions, never reveals secrets) always take precedence and can't be overridden here."
      >
        <Textarea
          id="chat-persona"
          value={draft.persona ?? ''}
          onChange={(e) => set('persona', e.target.value.slice(0, PERSONA_MAX_LENGTH))}
          rows={3}
          maxLength={PERSONA_MAX_LENGTH}
          placeholder={DEFAULT_PERSONA_PLACEHOLDER}
          disabled={update.isPending}
        />
      </FormField>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField
          label="Recent-message context"
          htmlFor="chat-history"
          hint="How many prior messages (by the mentioning user or the bot) to include, 0-10."
        >
          <Input
            id="chat-history"
            type="number"
            min={0}
            max={10}
            value={draft.historyMessages}
            onChange={(e) => set('historyMessages', Number(e.target.value))}
            disabled={update.isPending}
          />
        </FormField>

        <FormField
          label="Max reply length (chars)"
          htmlFor="chat-max-reply"
          hint="200-2000. The completion itself is separately capped by the platform."
        >
          <Input
            id="chat-max-reply"
            type="number"
            min={200}
            max={2000}
            value={draft.maxReplyChars}
            onChange={(e) => set('maxReplyChars', Number(e.target.value))}
            disabled={update.isPending}
          />
        </FormField>
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-4">
        <Button onClick={handleSave} disabled={!dirty || update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
