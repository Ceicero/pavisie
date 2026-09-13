'use client';

import { Plus, X } from 'lucide-react';
import type { EnforcerMatcherDto } from '@pavisie/types';
import {
  Button,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@pavisie/ui';

const MATCHER_TYPES: { value: EnforcerMatcherDto['type']; label: string }[] = [
  { value: 'keyword', label: 'Keyword (word match)' },
  { value: 'phrase', label: 'Phrase (substring)' },
  { value: 'regex', label: 'Regex' },
  { value: 'link_domain', label: 'Link domain (blank = any link)' },
  { value: 'invite', label: 'Discord invite link' },
  { value: 'mention_count', label: 'Mention count' },
  { value: 'attachment_ext', label: 'Attachment extension' },
  { value: 'ai_category', label: 'AI category (assistive only)' },
];

function valueToText(value: EnforcerMatcherDto['value']): string {
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
}

function textToValue(type: EnforcerMatcherDto['type'], text: string): EnforcerMatcherDto['value'] {
  if (type === 'mention_count') {
    const n = Number(text);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === 'regex' || type === 'invite' || type === 'ai_category') return text;
  const list = text
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return list;
}

export interface MatcherBuilderProps {
  matchers: EnforcerMatcherDto[];
  onChange: (next: EnforcerMatcherDto[]) => void;
  disabled?: boolean;
}

export function MatcherBuilder({ matchers, onChange, disabled }: MatcherBuilderProps) {
  function updateMatcher(index: number, patch: Partial<EnforcerMatcherDto>) {
    onChange(matchers.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  }

  function removeMatcher(index: number) {
    onChange(matchers.filter((_, i) => i !== index));
  }

  function addMatcher() {
    onChange([...matchers, { type: 'keyword', value: '' }]);
  }

  return (
    <div className="space-y-3">
      {matchers.map((matcher, index) => (
        <div key={index} className="space-y-2 rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            <Select
              value={matcher.type}
              onValueChange={(v) =>
                updateMatcher(index, {
                  type: v as EnforcerMatcherDto['type'],
                  value: v === 'mention_count' ? 1 : '',
                })
              }
              disabled={disabled}
            >
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MATCHER_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeMatcher(index)}
              disabled={disabled || matchers.length <= 1}
              aria-label="Remove matcher"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {matcher.type === 'invite' ? (
            <p className="text-xs text-muted-foreground">
              Matches any Discord invite link found in the message — no value needed.
            </p>
          ) : matcher.type === 'mention_count' ? (
            <Input
              type="number"
              min={1}
              value={typeof matcher.value === 'number' ? matcher.value : 1}
              onChange={(e) => updateMatcher(index, { value: Number(e.target.value) })}
              disabled={disabled}
              placeholder="Threshold, e.g. 5"
            />
          ) : (
            <Input
              value={valueToText(matcher.value)}
              onChange={(e) => updateMatcher(index, { value: textToValue(matcher.type, e.target.value) })}
              disabled={disabled}
              placeholder={
                matcher.type === 'regex'
                  ? 'Regex pattern'
                  : matcher.type === 'link_domain'
                    ? 'Comma-separated domains, blank = any link'
                    : 'Comma-separated values'
              }
            />
          )}

          {matcher.type === 'keyword' || matcher.type === 'phrase' || matcher.type === 'regex' ? (
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={Boolean(matcher.caseSensitive)}
                  onCheckedChange={(v) => updateMatcher(index, { caseSensitive: v === true })}
                  disabled={disabled}
                />
                Case-sensitive
              </label>
              {matcher.type === 'keyword' ? (
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={matcher.wholeWord !== false}
                    onCheckedChange={(v) => updateMatcher(index, { wholeWord: v === true })}
                    disabled={disabled}
                  />
                  Whole word only
                </label>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={addMatcher} disabled={disabled}>
        <Plus className="h-4 w-4" />
        Add matcher
      </Button>
    </div>
  );
}
