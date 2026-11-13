'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pagination } from '@pavisie/ui';
import { Glass } from '@/components/Glass';
import { Button } from '@/components/Button';
import {
  EMPTY_LEADERBOARD_MESSAGE,
  NOT_PUBLIC_MESSAGE,
  PUBLIC_LEADERBOARD_LIMIT,
  fetchPublicLeaderboard,
  formatVoiceMinutes,
  isNotPublicError,
  leaderboardDisplayName,
  publicLeaderboardQueryKeys,
  type PublicLeaderboardEntryDto,
} from '@/lib/public/leaderboard';

function usePublicLeaderboard(guildId: string, cursor?: string) {
  return useQuery({
    queryKey: publicLeaderboardQueryKeys.page(guildId, cursor),
    queryFn: () => fetchPublicLeaderboard(guildId, cursor),
    retry: (failureCount, error) => (isNotPublicError(error) ? false : failureCount < 1),
  });
}

function MemberAvatar({ entry, name }: { entry: PublicLeaderboardEntryDto; name: string }) {
  if (entry.avatarUrl) {
    return <img src={entry.avatarUrl} alt="" className="h-10 w-10 shrink-0 rounded-full" />;
  }
  const initial = name === 'Unknown user' ? '?' : name.charAt(0).toUpperCase();
  return (
    <span
      aria-hidden
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-4 text-sm font-medium text-grey-7"
    >
      {initial}
    </span>
  );
}

export function PublicLeaderboard({ guildId }: { guildId: string }) {
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];
  const { data, error, isLoading, isFetching, refetch } = usePublicLeaderboard(guildId, cursor);

  if (isLoading) {
    return (
      <Glass className="p-6 sm:p-8">
        <p className="text-sm text-grey-3">Loading the leaderboard…</p>
      </Glass>
    );
  }

  if (isNotPublicError(error)) {
    return (
      <Glass className="p-6 sm:p-8">
        <p className="text-sm leading-relaxed text-grey-3">{NOT_PUBLIC_MESSAGE}</p>
      </Glass>
    );
  }

  if (error) {
    const message =
      error instanceof Error ? error.message : 'Something went wrong. Please try again.';
    return (
      <Glass className="p-6 sm:p-8">
        <p className="text-sm leading-relaxed text-grey-3">{message}</p>
        <Button
          type="button"
          variant="secondary"
          className="mt-4"
          onClick={() => {
            void refetch();
          }}
        >
          Try again
        </Button>
      </Glass>
    );
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  if (items.length === 0) {
    return (
      <Glass className="p-6 sm:p-8">
        <p className="text-sm leading-relaxed text-grey-3">{EMPTY_LEADERBOARD_MESSAGE}</p>
      </Glass>
    );
  }

  const pageIndex = cursorStack.length - 1;
  const start = pageIndex * PUBLIC_LEADERBOARD_LIMIT + 1;
  const end = start + items.length - 1;
  const label =
    total > 0 ? `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}` : undefined;

  return (
    <Glass className="overflow-hidden p-0 sm:p-0">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 text-xs uppercase tracking-wider text-grey-3">
              <th scope="col" className="px-6 py-3 font-medium">
                Rank
              </th>
              <th scope="col" className="px-6 py-3 font-medium">
                Member
              </th>
              <th scope="col" className="px-6 py-3 font-medium">
                Level
              </th>
              <th scope="col" className="px-6 py-3 font-medium">
                XP
              </th>
              <th scope="col" className="px-6 py-3 font-medium">
                Messages
              </th>
              <th scope="col" className="px-6 py-3 font-medium">
                Voice
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => {
              const name = leaderboardDisplayName(entry);
              return (
                <tr key={entry.userId} className="border-b border-white/5 last:border-0">
                  <td className="whitespace-nowrap px-6 py-3 font-medium tabular-nums text-grey-7">
                    {entry.rank.toLocaleString()}
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex items-center gap-3">
                      <MemberAvatar entry={entry} name={name} />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-grey-7">{name}</p>
                        {entry.username && name !== entry.username ? (
                          <p className="truncate text-xs text-grey-3">@{entry.username}</p>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-6 py-3 tabular-nums text-grey-7">
                    {entry.level.toLocaleString()}
                  </td>
                  <td className="whitespace-nowrap px-6 py-3 tabular-nums text-grey-7">
                    {entry.xp.toLocaleString()}
                  </td>
                  <td className="whitespace-nowrap px-6 py-3 tabular-nums text-grey-7">
                    {entry.messages.toLocaleString()}
                  </td>
                  <td className="whitespace-nowrap px-6 py-3 tabular-nums text-grey-7">
                    {formatVoiceMinutes(entry.voiceMinutes)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-white/10 px-6 py-4">
        <Pagination
          hasPrevious={cursorStack.length > 1}
          hasNext={Boolean(data?.nextCursor)}
          loading={isFetching}
          label={label}
          onPrevious={() => setCursorStack((prev) => prev.slice(0, -1))}
          onNext={() => data?.nextCursor && setCursorStack((prev) => [...prev, data.nextCursor ?? undefined])}
        />
      </div>
    </Glass>
  );
}
