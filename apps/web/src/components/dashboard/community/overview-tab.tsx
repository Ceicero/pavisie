'use client';

import { Gift, ListChecks, Megaphone, MessageSquareText, Vote } from 'lucide-react';
import { StatCard } from '@pavisie/ui';
import {
  useCommunityAnnouncements,
  useCommunityEvents,
  useCommunityGiveaways,
  useCommunityPolls,
  useCommunitySuggestions,
} from '@/lib/dashboard/community-queries';

export function OverviewTab({ guildId }: { guildId: string }) {
  const giveaways = useCommunityGiveaways(guildId);
  const polls = useCommunityPolls(guildId);
  const suggestions = useCommunitySuggestions(guildId, 'PENDING');
  const announcements = useCommunityAnnouncements(guildId);
  const events = useCommunityEvents(guildId);

  const activeGiveaways = giveaways.data?.items.filter((g) => !g.ended).length ?? 0;
  const openPolls = polls.data?.items.filter((p) => !p.closed).length ?? 0;
  const pendingSuggestions = suggestions.data?.items.length ?? 0;
  const scheduledAnnouncements = announcements.data?.items.filter((a) => a.enabled).length ?? 0;
  const upcomingEvents =
    events.data?.items.filter((e) => new Date(e.startsAt).getTime() > Date.now()).length ?? 0;

  const loading =
    giveaways.isLoading ||
    polls.isLoading ||
    suggestions.isLoading ||
    announcements.isLoading ||
    events.isLoading;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Counts reflect the most recent page loaded in each tab below — open a tab for the full, paginated
        list.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Active giveaways" value={loading ? '—' : activeGiveaways} icon={<Gift />} />
        <StatCard label="Open polls" value={loading ? '—' : openPolls} icon={<Vote />} />
        <StatCard
          label="Pending suggestions"
          value={loading ? '—' : pendingSuggestions}
          icon={<MessageSquareText />}
        />
        <StatCard
          label="Scheduled announcements"
          value={loading ? '—' : scheduledAnnouncements}
          icon={<Megaphone />}
        />
        <StatCard label="Upcoming events" value={loading ? '—' : upcomingEvents} icon={<ListChecks />} />
      </div>
    </div>
  );
}
