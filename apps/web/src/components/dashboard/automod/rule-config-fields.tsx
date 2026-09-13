'use client';

import type { AutomodRuleTypeValue } from '@pavisie/types/automod';
import { FormField, Input, Switch } from '@pavisie/ui';
import { TagInput } from './tag-input';

export interface RuleConfigFieldsProps {
  type: AutomodRuleTypeValue;
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
}

function num(config: Record<string, unknown>, key: string, fallback: number): number {
  const v = config[key];
  return typeof v === 'number' ? v : fallback;
}

function bool(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = config[key];
  return typeof v === 'boolean' ? v : fallback;
}

function strList(config: Record<string, unknown>, key: string): string[] {
  const v = config[key];
  return Array.isArray(v) ? (v as string[]) : [];
}

function str(config: Record<string, unknown>, key: string, fallback = ''): string {
  const v = config[key];
  return typeof v === 'string' ? v : fallback;
}

function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}) {
  return (
    <FormField label={label} hint={hint}>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </FormField>
  );
}

function BoolField({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (b: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <Switch checked={value} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

/** Renders the type-specific config fields for one `AutomodRuleType`, mirroring `packages/plugins/src/automod/commands/rule-fields.ts`'s field list (kept in sync by hand — the bot's modal and this form both ultimately validate against the same shared `automodRuleConfigSchema`). */
export function RuleConfigFields({ type, config, onChange, disabled }: RuleConfigFieldsProps) {
  const set = (patch: Record<string, unknown>) => onChange({ ...config, ...patch });

  switch (type) {
    case 'MESSAGE_FREQUENCY':
      return (
        <>
          <NumberField
            label="Max messages"
            value={num(config, 'maxMessages', 5)}
            min={1}
            max={50}
            onChange={(n) => set({ maxMessages: n })}
            disabled={disabled}
          />
          <NumberField
            label="Window (seconds)"
            value={num(config, 'windowSeconds', 10)}
            min={1}
            max={300}
            onChange={(n) => set({ windowSeconds: n })}
            disabled={disabled}
          />
        </>
      );
    case 'DUPLICATE_MESSAGES':
      return (
        <>
          <NumberField
            label="Max duplicates"
            value={num(config, 'maxDuplicates', 3)}
            min={2}
            max={20}
            onChange={(n) => set({ maxDuplicates: n })}
            disabled={disabled}
          />
          <NumberField
            label="Window (seconds)"
            value={num(config, 'windowSeconds', 60)}
            min={1}
            max={600}
            onChange={(n) => set({ windowSeconds: n })}
            disabled={disabled}
          />
        </>
      );
    case 'MENTION_SPAM':
      return (
        <>
          <NumberField
            label="Max mentions"
            value={num(config, 'maxMentions', 5)}
            min={1}
            max={50}
            onChange={(n) => set({ maxMentions: n })}
            disabled={disabled}
          />
          <BoolField
            label="Count role mentions too"
            value={bool(config, 'includeRoleMentions', true)}
            onChange={(b) => set({ includeRoleMentions: b })}
            disabled={disabled}
          />
        </>
      );
    case 'INVITE_LINKS':
      return (
        <>
          <BoolField
            label="Allow this server's own invites"
            value={bool(config, 'allowOwnServerInvites', true)}
            onChange={(b) => set({ allowOwnServerInvites: b })}
            disabled={disabled}
          />
          <FormField
            label="Additional allowed invite codes"
            hint="e.g. abc123 (without the discord.gg/ prefix)"
          >
            <TagInput
              value={strList(config, 'allowedInviteCodes')}
              onChange={(v) => set({ allowedInviteCodes: v })}
              disabled={disabled}
            />
          </FormField>
        </>
      );
    case 'SCAM_LINKS':
      return (
        <>
          <BoolField
            label="Use the built-in scam/phishing list"
            value={bool(config, 'useBuiltInList', true)}
            onChange={(b) => set({ useBuiltInList: b })}
            disabled={disabled}
          />
          <FormField label="Additional blocked domains" hint="e.g. scam-example.com">
            <TagInput
              value={strList(config, 'blockedDomains')}
              onChange={(v) => set({ blockedDomains: v })}
              disabled={disabled}
            />
          </FormField>
        </>
      );
    case 'REGEX_FILTER':
      return (
        <>
          <FormField
            label="Regex pattern"
            hint="Validated for catastrophic-backtracking risk on save."
            required
          >
            <Input
              value={str(config, 'pattern')}
              onChange={(e) => set({ pattern: e.target.value })}
              disabled={disabled}
              placeholder="e.g. \bfree\s?nitro\b"
            />
          </FormField>
          <FormField label="Regex flags" hint="Default: i (case-insensitive)">
            <Input
              value={str(config, 'flags', 'i')}
              onChange={(e) => set({ flags: e.target.value })}
              disabled={disabled}
              maxLength={5}
            />
          </FormField>
        </>
      );
    case 'WORD_FILTER':
      return (
        <>
          <FormField label="Words / phrases" required>
            <TagInput
              value={strList(config, 'words')}
              onChange={(v) => set({ words: v })}
              disabled={disabled}
            />
          </FormField>
          <BoolField
            label="Whole-word match only"
            value={bool(config, 'wholeWord', true)}
            onChange={(b) => set({ wholeWord: b })}
            disabled={disabled}
          />
          <BoolField
            label="Case sensitive"
            value={bool(config, 'caseSensitive', false)}
            onChange={(b) => set({ caseSensitive: b })}
            disabled={disabled}
          />
        </>
      );
    case 'CAPS':
      return (
        <>
          <NumberField
            label="Minimum message length to check"
            value={num(config, 'minLength', 10)}
            min={1}
            max={2000}
            onChange={(n) => set({ minLength: n })}
            disabled={disabled}
          />
          <NumberField
            label="Max uppercase %"
            value={num(config, 'maxCapsPercent', 70)}
            min={1}
            max={100}
            onChange={(n) => set({ maxCapsPercent: n })}
            disabled={disabled}
          />
        </>
      );
    case 'REPEATED_CHARS':
      return (
        <NumberField
          label="Max repeated characters in a row"
          value={num(config, 'maxRepeats', 6)}
          min={2}
          max={50}
          onChange={(n) => set({ maxRepeats: n })}
          disabled={disabled}
        />
      );
    case 'ATTACHMENTS':
      return (
        <>
          <FormField label="Blocked file extensions" hint="e.g. exe, bat, scr, msi, jar, cmd">
            <TagInput
              value={strList(config, 'blockedExtensions')}
              onChange={(v) => set({ blockedExtensions: v })}
              disabled={disabled}
            />
          </FormField>
          <NumberField
            label="Max attachments per message"
            hint="Leave at 0 to disable this check"
            value={num(config, 'maxAttachments', 0)}
            min={0}
            max={20}
            onChange={(n) => set({ maxAttachments: n })}
            disabled={disabled}
          />
        </>
      );
    case 'NSFW_ENFORCEMENT':
      return (
        <FormField label="Keywords requiring an NSFW channel" required>
          <TagInput
            value={strList(config, 'requireNsfwChannelForKeywords')}
            onChange={(v) => set({ requireNsfwChannelForKeywords: v })}
            disabled={disabled}
          />
        </FormField>
      );
    case 'ACCOUNT_AGE':
      return (
        <NumberField
          label="Minimum account age (hours)"
          value={num(config, 'minAccountAgeHours', 24)}
          min={0}
          max={24 * 365}
          onChange={(n) => set({ minAccountAgeHours: n })}
          disabled={disabled}
        />
      );
    case 'RAID_DETECTION':
      return (
        <>
          <NumberField
            label="Joins to trigger"
            value={num(config, 'joinBurstCount', 10)}
            min={2}
            max={200}
            onChange={(n) => set({ joinBurstCount: n })}
            disabled={disabled}
          />
          <NumberField
            label="Within (seconds)"
            value={num(config, 'joinBurstWindowSeconds', 30)}
            min={1}
            max={3600}
            onChange={(n) => set({ joinBurstWindowSeconds: n })}
            disabled={disabled}
          />
        </>
      );
    default:
      return null;
  }
}
