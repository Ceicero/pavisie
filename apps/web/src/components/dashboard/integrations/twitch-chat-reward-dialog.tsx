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
  Textarea,
  useToast,
} from '@pavisie/ui';
import type {
  CreateTwitchChatRewardInput,
  TwitchChatRewardDto,
  TwitchRewardActionKindId,
  UpdateTwitchChatRewardInput,
} from '@pavisie/types/integrations';
import { TWITCH_REWARD_ACTION_KINDS } from '@pavisie/types/integrations';
import { ApiClientError } from '@/lib/dashboard/api';
import {
  useCreateTwitchChatReward,
  useUpdateTwitchChatReward,
} from '@/lib/dashboard/integrations-queries';
import { DiscordChannelSelect } from '../discord-selects';

/** Client-side validation mirrors the server in `apps/api/src/lib/integrations/twitch-chat-schemas.ts`. */
const TITLE_MIN = 1;
const TITLE_MAX = 100;
const TEMPLATE_MIN = 1;
const TEMPLATE_MAX = 300;
const COOLDOWN_MIN = 0;
const COOLDOWN_MAX = 3600;
const VOLUME_MIN = 0;
const VOLUME_MAX = 100;

const ACTION_LABELS: Record<TwitchRewardActionKindId, string> = {
  sound: 'Play sound',
  tts: 'Text-to-speech',
  chat: 'Post to chat',
  discord: 'Send to Discord',
};

export interface TwitchChatRewardDialogProps {
  guildId: string;
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing an existing reward; omitted/null when creating a new one. */
  reward?: TwitchChatRewardDto | null;
}

export function TwitchChatRewardDialog({
  guildId,
  channelId,
  open,
  onOpenChange,
  reward,
}: TwitchChatRewardDialogProps) {
  const isEdit = Boolean(reward);
  const [title, setTitle] = React.useState('');
  const [action, setAction] = React.useState<TwitchRewardActionKindId>('sound');
  const [cooldownSeconds, setCooldownSeconds] = React.useState(0);
  const [soundUrl, setSoundUrl] = React.useState('');
  const [volume, setVolume] = React.useState(100);
  const [ttsTemplate, setTtsTemplate] = React.useState('');
  const [chatTemplate, setChatTemplate] = React.useState('');
  const [discordChannelId, setDiscordChannelId] = React.useState<string | null>(null);
  const [discordTemplate, setDiscordTemplate] = React.useState('');

  const create = useCreateTwitchChatReward(guildId);
  const update = useUpdateTwitchChatReward(guildId);
  const { toast } = useToast();
  const saving = create.isPending || update.isPending;

  React.useEffect(() => {
    if (!open) return;
    if (reward) {
      setTitle(reward.rewardTitle);
      setAction(reward.action);
      setCooldownSeconds(reward.cooldownSeconds);
      setSoundUrl(reward.soundUrl ?? '');
      setVolume(reward.volume);
      setTtsTemplate(reward.ttsTemplate ?? '');
      setChatTemplate(reward.chatTemplate ?? '');
      setDiscordChannelId(reward.discordChannelId ?? null);
      setDiscordTemplate(reward.discordTemplate ?? '');
    } else {
      setTitle('');
      setAction('sound');
      setCooldownSeconds(0);
      setSoundUrl('');
      setVolume(100);
      setTtsTemplate('');
      setChatTemplate('');
      setDiscordChannelId(null);
      setDiscordTemplate('');
    }
  }, [open, reward]);

  const trimmedTitle = title.trim();
  const titleValid = trimmedTitle.length >= TITLE_MIN && trimmedTitle.length <= TITLE_MAX;
  const cooldownValid =
    Number.isInteger(cooldownSeconds) &&
    cooldownSeconds >= COOLDOWN_MIN &&
    cooldownSeconds <= COOLDOWN_MAX;
  const volumeValid = Number.isInteger(volume) && volume >= VOLUME_MIN && volume <= VOLUME_MAX;

  // Validate action-specific fields
  const trimmedSoundUrl = soundUrl.trim();
  const soundValid = action !== 'sound' || trimmedSoundUrl.length > 0;
  const trimmedTtsTemplate = ttsTemplate.trim();
  const ttsValid =
    action !== 'tts' ||
    (trimmedTtsTemplate.length >= TEMPLATE_MIN && trimmedTtsTemplate.length <= TEMPLATE_MAX);
  const trimmedChatTemplate = chatTemplate.trim();
  const chatValid =
    action !== 'chat' ||
    (trimmedChatTemplate.length >= TEMPLATE_MIN && trimmedChatTemplate.length <= TEMPLATE_MAX);
  const trimmedDiscordTemplate = discordTemplate.trim();
  const discordValid =
    action !== 'discord' ||
    (Boolean(discordChannelId) &&
      trimmedDiscordTemplate.length >= TEMPLATE_MIN &&
      trimmedDiscordTemplate.length <= TEMPLATE_MAX);

  const valid =
    titleValid &&
    cooldownValid &&
    volumeValid &&
    soundValid &&
    ttsValid &&
    chatValid &&
    discordValid;

  function handleSave() {
    if (!valid) return;
    const onSuccess = () => {
      toast({ title: isEdit ? 'Reward updated' : 'Reward added', variant: 'success' });
      onOpenChange(false);
    };
    const onError = (err: unknown) =>
      toast({
        title: 'Could not save the reward',
        description: err instanceof ApiClientError ? err.message : 'Please try again.',
        variant: 'destructive',
      });

    if (isEdit && reward) {
      const patch: UpdateTwitchChatRewardInput = {
        rewardTitle: trimmedTitle,
        action,
        cooldownSeconds,
      };

      if (action === 'sound') {
        patch.soundUrl = trimmedSoundUrl;
        patch.volume = volume;
      } else if (action === 'tts') {
        patch.ttsTemplate = trimmedTtsTemplate;
      } else if (action === 'chat') {
        patch.chatTemplate = trimmedChatTemplate;
      } else if (action === 'discord') {
        patch.discordChannelId = discordChannelId;
        patch.discordTemplate = trimmedDiscordTemplate;
      }

      update.mutate(
        {
          rewardId: reward.id,
          channelId,
          patch,
        },
        { onSuccess, onError },
      );
    } else {
      const input: CreateTwitchChatRewardInput = {
        rewardTitle: trimmedTitle,
        action,
        cooldownSeconds,
      };

      if (action === 'sound') {
        input.soundUrl = trimmedSoundUrl;
        input.volume = volume;
      } else if (action === 'tts') {
        input.ttsTemplate = trimmedTtsTemplate;
      } else if (action === 'chat') {
        input.chatTemplate = trimmedChatTemplate;
      } else if (action === 'discord') {
        input.discordChannelId = discordChannelId;
        input.discordTemplate = trimmedDiscordTemplate;
      }

      create.mutate(
        { channelId, input },
        { onSuccess, onError },
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-screen overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit reward: ${reward?.rewardTitle}` : 'Add a channel-point reward'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <FormField
            label="Reward title"
            required
            hint={`${TITLE_MIN}-${TITLE_MAX} characters.`}
            error={title.length > 0 && !titleValid ? 'Invalid title length.' : undefined}
          >
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
              disabled={saving}
              placeholder="Victory royale"
            />
          </FormField>

          <FormField label="Action" required>
            <Select value={action} onValueChange={(v) => setAction(v as TwitchRewardActionKindId)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TWITCH_REWARD_ACTION_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {ACTION_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {action === 'sound' ? (
            <>
              <FormField
                label="Sound URL"
                required
                hint="Direct link to .mp3 or .wav file."
                error={soundUrl.length > 0 && !soundValid ? 'URL required.' : undefined}
              >
                <Input
                  value={soundUrl}
                  onChange={(e) => setSoundUrl(e.target.value)}
                  disabled={saving}
                  placeholder="https://example.com/sounds/victory.mp3"
                />
              </FormField>
              <FormField label="Volume" required hint={`${VOLUME_MIN}–${VOLUME_MAX}%.`}>
                <Input
                  type="number"
                  min={VOLUME_MIN}
                  max={VOLUME_MAX}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.target.value) || 0)}
                  disabled={saving}
                />
              </FormField>
            </>
          ) : null}

          {action === 'tts' ? (
            <>
              <FormField
                label="Text template"
                required
                hint={`${TEMPLATE_MIN}-${TEMPLATE_MAX} characters.`}
                error={
                  ttsTemplate.length > 0 && !ttsValid ? `Template must be ${TEMPLATE_MIN}-${TEMPLATE_MAX} characters.` : undefined
                }
              >
                <Textarea
                  value={ttsTemplate}
                  onChange={(e) => setTtsTemplate(e.target.value)}
                  maxLength={TEMPLATE_MAX}
                  rows={3}
                  disabled={saving}
                  placeholder="Thanks {displayName} for the gift!"
                />
              </FormField>
              <p className="text-xs text-muted-foreground">
                Text-to-speech uses your server's own OpenAI key from the AI plugin. Without one, TTS rewards stay
                silent.
              </p>
            </>
          ) : null}

          {action === 'chat' ? (
            <FormField
              label="Chat message template"
              required
              hint={`${TEMPLATE_MIN}-${TEMPLATE_MAX} characters.`}
              error={
                chatTemplate.length > 0 && !chatValid
                  ? `Template must be ${TEMPLATE_MIN}-${TEMPLATE_MAX} characters.`
                  : undefined
              }
            >
              <Textarea
                value={chatTemplate}
                onChange={(e) => setChatTemplate(e.target.value)}
                maxLength={TEMPLATE_MAX}
                rows={3}
                disabled={saving}
                placeholder="Thanks {displayName} for the gift!"
              />
            </FormField>
          ) : null}

          {action === 'discord' ? (
            <>
              <FormField label="Discord channel" required>
                <DiscordChannelSelect
                  guildId={guildId}
                  value={discordChannelId}
                  onChange={setDiscordChannelId}
                />
              </FormField>
              <FormField
                label="Message template"
                required
                hint={`${TEMPLATE_MIN}-${TEMPLATE_MAX} characters.`}
                error={
                  discordTemplate.length > 0 && !discordValid
                    ? `Template must be ${TEMPLATE_MIN}-${TEMPLATE_MAX} characters. Channel required.`
                    : undefined
                }
              >
                <Textarea
                  value={discordTemplate}
                  onChange={(e) => setDiscordTemplate(e.target.value)}
                  maxLength={TEMPLATE_MAX}
                  rows={3}
                  disabled={saving}
                  placeholder="Thanks {displayName} for the gift!"
                />
              </FormField>
            </>
          ) : null}

          <FormField
            label="Cooldown (seconds)"
            required
            hint={`${COOLDOWN_MIN}–${COOLDOWN_MAX} seconds.`}
          >
            <Input
              type="number"
              min={COOLDOWN_MIN}
              max={COOLDOWN_MAX}
              value={cooldownSeconds}
              onChange={(e) => setCooldownSeconds(Number(e.target.value) || 0)}
              disabled={saving}
            />
          </FormField>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!valid || saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add reward'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
