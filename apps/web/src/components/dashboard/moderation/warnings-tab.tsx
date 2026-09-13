'use client';

import * as React from 'react';
import { Badge, Button, EmptyState, Input, Skeleton } from '@pavisie/ui';
import { ErrorState } from '../error-state';
import { useModerationWarnings } from '@/lib/dashboard/moderation-queries';

export function WarningsTab({ guildId }: { guildId: string }) {
  const [userIdInput, setUserIdInput] = React.useState('');
  const [userId, setUserId] = React.useState<string | undefined>(undefined);
  const { data, isLoading, error, refetch } = useModerationWarnings(guildId, userId);

  function search() {
    setUserId(userIdInput.trim() || undefined);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by user id"
          className="max-w-xs"
          value={userIdInput}
          onChange={(e) => setUserIdInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <Button onClick={search}>Search</Button>
      </div>

      {!userId ? (
        <EmptyState
          title="Search for a member"
          description="Enter a Discord user id above to see their warning history."
        />
      ) : error ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : (data?.items ?? []).length === 0 ? (
        <EmptyState title="No warnings" description="This user has no warnings on record." />
      ) : (
        <ul className="space-y-2">
          {data?.items.map((w) => (
            <li
              key={w.id}
              className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
            >
              <div>
                <p className="text-sm">{w.reason ?? '_No reason given_'}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Case linked: <span className="font-mono">{w.caseId}</span> · Moderator{' '}
                  <span className="font-mono">{w.moderatorId}</span>
                </p>
              </div>
              <Badge variant={w.active ? 'warning' : 'outline'}>{w.active ? 'Active' : 'Cleared'}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
