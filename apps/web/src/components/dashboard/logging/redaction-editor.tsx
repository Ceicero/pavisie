'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { LoggingConfigDto } from '@pavisie/types/logging';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FormField,
  Input,
  Textarea,
  useToast,
} from '@pavisie/ui';
import { useRedactionTest } from '@/lib/dashboard/logging-queries';
import { ApiClientError } from '@/lib/dashboard/api';

const BUILT_IN_PATTERN_NAMES = ['email', 'phone', 'discord_token', 'credit_card', 'ipv4'];

export interface RedactionEditorProps {
  guildId: string;
  draft: LoggingConfigDto;
  onChange: (next: LoggingConfigDto) => void;
  disabled?: boolean;
}

/** Custom redaction pattern list (add/remove) plus a live test box against the API's `POST .../redaction/test` (which also exercises the built-in patterns). */
export function RedactionEditor({ guildId, draft, onChange, disabled }: RedactionEditorProps) {
  const [newPattern, setNewPattern] = React.useState('');
  const [testText, setTestText] = React.useState('Example: reach me at test@example.com or 555-123-4567');
  const { toast } = useToast();
  const test = useRedactionTest(guildId);

  function addPattern() {
    const pattern = newPattern.trim();
    if (!pattern) return;
    if (draft.redactionPatterns.includes(pattern)) {
      toast({ title: 'Pattern already added', variant: 'destructive' });
      return;
    }
    onChange({ ...draft, redactionPatterns: [...draft.redactionPatterns, pattern] });
    setNewPattern('');
  }

  function removePattern(pattern: string) {
    onChange({ ...draft, redactionPatterns: draft.redactionPatterns.filter((p) => p !== pattern) });
  }

  function runTest() {
    test.mutate(
      { text: testText },
      {
        onError: (err) =>
          toast({
            title: 'Test failed',
            description: err instanceof ApiClientError ? err.message : undefined,
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Custom redaction patterns</CardTitle>
          <CardDescription>
            Built-in patterns (always on, in every server): email addresses, phone numbers, Discord tokens,
            credit-card-like numbers, IPv4 addresses. Add your own regex below — patterns run
            case-insensitively.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="e.g. \\bSSN[:\\s]*\\d{3}-\\d{2}-\\d{4}\\b"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              disabled={disabled}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addPattern();
              }}
            />
            <Button variant="outline" onClick={addPattern} disabled={disabled || !newPattern.trim()}>
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>

          {draft.redactionPatterns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No custom patterns yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {draft.redactionPatterns.map((pattern, i) => (
                <li
                  key={pattern}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <code className="truncate text-xs">
                    {i + 1}. {pattern}
                  </code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removePattern(pattern)}
                    disabled={disabled}
                    aria-label={`Remove pattern ${i + 1}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Test redaction</CardTitle>
          <CardDescription>
            Runs against the patterns currently saved on the server (save changes above first to test unsaved
            edits).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <FormField label="Sample text">
            <Textarea value={testText} onChange={(e) => setTestText(e.target.value)} rows={3} />
          </FormField>
          <Button variant="outline" onClick={runTest} disabled={test.isPending || !testText.trim()}>
            {test.isPending ? 'Testing…' : 'Run test'}
          </Button>

          {test.data ? (
            <div className="space-y-2 pt-2">
              <FormField label="Redacted result">
                <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                  {test.data.redacted}
                </div>
              </FormField>
              <div className="flex flex-wrap gap-1.5">
                {test.data.matches.map((m) => (
                  <Badge key={m.name} variant={m.matched ? 'default' : 'secondary'}>
                    {BUILT_IN_PATTERN_NAMES.includes(m.name) ? m.name : `custom: ${m.name}`}
                    {m.matched ? '' : ' (no match)'}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
