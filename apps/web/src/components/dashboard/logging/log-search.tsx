'use client';

import * as React from 'react';
import { Download, Search } from 'lucide-react';
import type { LogEventDto } from '@pavisie/types';
import { LOG_KINDS, LOG_KIND_LABELS } from '@pavisie/types/logging';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  EmptyState,
  FormField,
  Input,
  Pagination,
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
} from '@pavisie/ui';
import { logsExportCsvUrl, useLogSearch, type LogSearchFilters } from '@/lib/dashboard/logging-queries';
import { ErrorState } from '../error-state';
import { formatDateTime } from '@/lib/dashboard/format';

const ALL_KINDS_VALUE = '__all__';

export interface LogSearchProps {
  guildId: string;
  storeEventsEnabled: boolean;
}

export function LogSearch({ guildId, storeEventsEnabled }: LogSearchProps) {
  const [filters, setFilters] = React.useState<LogSearchFilters>({ limit: 25 });
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const [detail, setDetail] = React.useState<LogEventDto | null>(null);

  const cursor = cursorStack[cursorStack.length - 1];
  const { data, isLoading, error, refetch } = useLogSearch(guildId, { ...filters, cursor });

  function updateFilter<K extends keyof LogSearchFilters>(key: K, value: LogSearchFilters[K]) {
    setCursorStack([undefined]);
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  if (!storeEventsEnabled) {
    return (
      <EmptyState
        title="Log storage is off"
        description="Turn on “Store events for search & export” in the Channels tab to make search and CSV export available."
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <FormField label="Kind">
            <Select
              value={filters.kind ?? ALL_KINDS_VALUE}
              onValueChange={(v) => updateFilter('kind', v === ALL_KINDS_VALUE ? undefined : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_KINDS_VALUE}>All kinds</SelectItem>
                {LOG_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {LOG_KIND_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Actor user ID" hint="Who did it">
            <Input
              value={filters.actorId ?? ''}
              placeholder="Discord user ID"
              onChange={(e) => updateFilter('actorId', e.target.value || undefined)}
            />
          </FormField>
          <FormField label="Target user ID" hint="Who it happened to">
            <Input
              value={filters.targetId ?? ''}
              placeholder="Discord user ID"
              onChange={(e) => updateFilter('targetId', e.target.value || undefined)}
            />
          </FormField>
          <FormField label="Search text" hint="Matches embed title/description">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                value={filters.q ?? ''}
                onChange={(e) => updateFilter('q', e.target.value || undefined)}
              />
            </div>
          </FormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Results</CardTitle>
          <Button variant="outline" size="sm" asChild>
            <a href={logsExportCsvUrl(guildId, filters)}>
              <Download className="h-4 w-4" />
              Export CSV
            </a>
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <ErrorState error={error} onRetry={() => refetch()} />
          ) : isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !data || data.items.length === 0 ? (
            <EmptyState
              title="No log events found"
              description="Try widening your filters, or check that events are being generated for this server."
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kind</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>
                        <Badge variant="outline">
                          {LOG_KIND_LABELS[event.kind as keyof typeof LOG_KIND_LABELS] ?? event.kind}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {(event.payload.actorId as string | undefined) ?? '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {(event.payload.targetId as string | undefined) ?? '—'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(event.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => setDetail(event)}>
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <Pagination
                hasPrevious={cursorStack.length > 1}
                hasNext={Boolean(data.nextCursor)}
                loading={isLoading}
                label={`${data.items.length} shown`}
                onPrevious={() => setCursorStack((prev) => prev.slice(0, -1))}
                onNext={() =>
                  data.nextCursor && setCursorStack((prev) => [...prev, data.nextCursor ?? undefined])
                }
              />
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {detail ? (LOG_KIND_LABELS[detail.kind as keyof typeof LOG_KIND_LABELS] ?? detail.kind) : ''}
            </DialogTitle>
          </DialogHeader>
          {detail ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{formatDateTime(detail.createdAt)}</p>
              <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
                {JSON.stringify(detail.payload, null, 2)}
              </pre>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
