'use client';

import Link from 'next/link';
import { Info } from 'lucide-react';
import { LOG_KINDS, LOG_KIND_LABELS, type LoggingConfigDto } from '@pavisie/types/logging';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  Input,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@pavisie/ui';
import { DiscordChannelSelect } from '../discord-selects';

export interface ChannelMapTableProps {
  guildId: string;
  draft: LoggingConfigDto;
  onChange: (next: LoggingConfigDto) => void;
  disabled?: boolean;
}

/** Per-kind channel routing table, an enable toggle per kind, a "default" fallback row, and the content-capture explainer (ARCHITECTURE.md's logging dashboard page spec). */
export function ChannelMapTable({ guildId, draft, onChange, disabled }: ChannelMapTableProps) {
  function setChannel(kind: string, channelId: string | null) {
    onChange({ ...draft, channels: { ...draft.channels, [kind]: channelId } });
  }

  function toggleEnabled(kind: (typeof LOG_KINDS)[number], enabled: boolean) {
    const nextEnabled = enabled
      ? Array.from(new Set([...draft.enabledKinds, kind]))
      : draft.enabledKinds.filter((k) => k !== kind);
    onChange({ ...draft, enabledKinds: nextEnabled });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Log channels</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormField
            label="Default channel"
            hint="Used for any enabled kind below that doesn't have its own channel set."
          >
            <DiscordChannelSelect
              guildId={guildId}
              value={draft.channels.default ?? null}
              onChange={(v) => setChannel('default', v)}
              disabled={disabled}
            />
          </FormField>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead className="w-24 text-right">Enabled</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {LOG_KINDS.map((kind) => (
                <TableRow key={kind}>
                  <TableCell className="font-medium">{LOG_KIND_LABELS[kind]}</TableCell>
                  <TableCell>
                    <DiscordChannelSelect
                      guildId={guildId}
                      value={draft.channels[kind] ?? null}
                      onChange={(v) => setChannel(kind, v)}
                      placeholder="Use default"
                      disabled={disabled}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Switch
                      checked={draft.enabledKinds.includes(kind)}
                      onCheckedChange={(v) => toggleEnabled(kind, v)}
                      disabled={disabled}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storage &amp; message content</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Store events for search &amp; export</p>
              <p className="text-xs text-muted-foreground">
                When off, log embeds still post to their channels live, but nothing is written to the
                searchable log — the Search tab and CSV export will be empty.
              </p>
            </div>
            <Switch
              checked={draft.storeEvents}
              onCheckedChange={(v) => onChange({ ...draft, storeEvents: v })}
              disabled={disabled}
            />
          </div>

          <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium">Capture message content on edit/delete</p>
              <p className="text-xs text-muted-foreground">
                Only takes effect together with this server&apos;s <strong>Log message content</strong>{' '}
                setting.
              </p>
            </div>
            <Switch
              checked={draft.captureContent}
              onCheckedChange={(v) => onChange({ ...draft, captureContent: v })}
              disabled={disabled}
            />
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>Two switches control message content</AlertTitle>
            <AlertDescription>
              Message text only ever appears in edit/delete logs when <strong>both</strong> this toggle and
              the server-wide{' '}
              <Link href={`/dashboard/${guildId}/settings`} className="underline underline-offset-2">
                Settings → &quot;Log message content&quot;
              </Link>{' '}
              are on. With either off, edit/delete logs record metadata only.
            </AlertDescription>
          </Alert>

          <FormField
            label="Retention (days)"
            hint="Log events older than this are purged daily. The server-wide data retention policy may shorten this further."
          >
            <Input
              type="number"
              min={1}
              max={3650}
              value={draft.retentionDays}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...draft, retentionDays: Math.max(1, Number(e.target.value) || 1) })
              }
              className="max-w-40"
            />
          </FormField>
        </CardContent>
      </Card>
    </div>
  );
}
