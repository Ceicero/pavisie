'use client';

import * as React from 'react';
import { Check, Plus, Trash2, X } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  useToast,
} from '@entrophy/ui';
import {
  useDecideVerification,
  useUpdateVerificationSettings,
  useVerificationQueue,
  useVerificationSettings,
} from '@/lib/dashboard/roles-queries';
import { DiscordChannelSelect, DiscordRoleSelect } from '../discord-selects';
import { ErrorState } from '../error-state';
import { ApiClientError } from '@/lib/dashboard/api';

export function VerificationTab({ guildId }: { guildId: string }) {
  const settings = useVerificationSettings(guildId);
  const updateSettings = useUpdateVerificationSettings(guildId);
  const queue = useVerificationQueue(guildId);
  const decide = useDecideVerification(guildId);
  const { toast } = useToast();

  const [draft, setDraft] = React.useState<{
    mode: 'button' | 'modal' | 'captcha';
    questions: string[];
    verifiedRoleId: string | null;
    staffChannelId: string | null;
    minAccountAgeDays: number;
    underageAction: 'none' | 'quarantine' | 'kick';
    quarantineRoleId: string | null;
  } | null>(null);

  React.useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  const [denyNoteFor, setDenyNoteFor] = React.useState<string | null>(null);
  const [denyNote, setDenyNote] = React.useState('');

  if (settings.error) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  if (settings.isLoading || !draft) return <Skeleton className="h-96 w-full" />;

  function saveSettings() {
    updateSettings.mutate(draft!, {
      onSuccess: () => toast({ title: 'Verification settings saved', variant: 'success' }),
      onError: (err) =>
        toast({
          title: 'Could not save',
          description: err instanceof ApiClientError ? err.message : undefined,
          variant: 'destructive',
        }),
    });
  }

  function handleDecide(requestId: string, approve: boolean, note?: string) {
    decide.mutate(
      { requestId, approve, note },
      {
        onSuccess: () => {
          toast({ title: approve ? 'Approved' : 'Denied', variant: 'success' });
          setDenyNoteFor(null);
          setDenyNote('');
        },
        onError: (err) =>
          toast({
            title: 'Could not decide',
            description: err instanceof ApiClientError ? err.message : undefined,
            variant: 'destructive',
          }),
      },
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Mode">
              <Select
                value={draft.mode}
                onValueChange={(v) => setDraft((p) => ({ ...p!, mode: v as typeof draft.mode }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="button">Button (instant)</SelectItem>
                  <SelectItem value="modal">Modal (staff-approved)</SelectItem>
                  <SelectItem value="captcha">CAPTCHA</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Verified role">
              <DiscordRoleSelect
                guildId={guildId}
                value={draft.verifiedRoleId}
                onChange={(v) => setDraft((p) => ({ ...p!, verifiedRoleId: v }))}
              />
            </FormField>
          </div>

          {draft.mode === 'modal' ? (
            <FormField label="Staff review channel">
              <DiscordChannelSelect
                guildId={guildId}
                value={draft.staffChannelId}
                onChange={(v) => setDraft((p) => ({ ...p!, staffChannelId: v }))}
              />
            </FormField>
          ) : null}

          {draft.mode === 'modal' ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Questions (up to 5)</p>
              {draft.questions.map((q, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    value={q}
                    maxLength={300}
                    onChange={(e) =>
                      setDraft((p) => ({
                        ...p!,
                        questions: p!.questions.map((x, xi) => (xi === i ? e.target.value : x)),
                      }))
                    }
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Remove question"
                    onClick={() =>
                      setDraft((p) => ({ ...p!, questions: p!.questions.filter((_, xi) => xi !== i) }))
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {draft.questions.length < 5 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDraft((p) => ({ ...p!, questions: [...p!.questions, ''] }))}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add question
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField label="Min account age (days)">
              <Input
                type="number"
                min={0}
                max={3650}
                value={draft.minAccountAgeDays}
                onChange={(e) => setDraft((p) => ({ ...p!, minAccountAgeDays: Number(e.target.value) }))}
              />
            </FormField>
            <FormField label="Underage action">
              <Select
                value={draft.underageAction}
                onValueChange={(v) =>
                  setDraft((p) => ({ ...p!, underageAction: v as typeof draft.underageAction }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="quarantine">Quarantine</SelectItem>
                  <SelectItem value="kick">Kick</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
            {draft.underageAction === 'quarantine' ? (
              <FormField label="Quarantine role">
                <DiscordRoleSelect
                  guildId={guildId}
                  value={draft.quarantineRoleId}
                  onChange={(v) => setDraft((p) => ({ ...p!, quarantineRoleId: v }))}
                />
              </FormField>
            ) : null}
          </div>

          <div className="flex justify-end">
            <Button onClick={saveSettings} disabled={updateSettings.isPending}>
              {updateSettings.isPending ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending queue</CardTitle>
        </CardHeader>
        <CardContent>
          {queue.error ? (
            <ErrorState error={queue.error} onRetry={() => queue.refetch()} />
          ) : queue.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !queue.data || queue.data.length === 0 ? (
            <EmptyState
              title="Nothing pending"
              description="Modal-mode verification requests waiting on staff review will show up here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.data.map((request) => (
                  <React.Fragment key={request.id}>
                    <TableRow>
                      <TableCell>
                        <code className="text-xs">{request.userId}</code>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{request.method.toLowerCase()}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(request.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleDecide(request.id, true)}
                            disabled={decide.isPending}
                          >
                            <Check className="mr-1 h-3.5 w-3.5" /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setDenyNoteFor(denyNoteFor === request.id ? null : request.id)}
                          >
                            <X className="mr-1 h-3.5 w-3.5" /> Deny
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {denyNoteFor === request.id ? (
                      <TableRow>
                        <TableCell colSpan={4}>
                          <div className="flex items-end gap-2">
                            <FormField label="Denial note (optional, sent to the member)" className="flex-1">
                              <Textarea
                                value={denyNote}
                                onChange={(e) => setDenyNote(e.target.value)}
                                rows={2}
                                maxLength={500}
                              />
                            </FormField>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => handleDecide(request.id, false, denyNote || undefined)}
                              disabled={decide.isPending}
                            >
                              Confirm deny
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}
                    {Array.isArray(request.answers) ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-xs text-muted-foreground">
                          {(request.answers as { question: string; answer: string }[]).map((a, i) => (
                            <p key={i}>
                              <strong>{a.question}:</strong> {a.answer}
                            </p>
                          ))}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
