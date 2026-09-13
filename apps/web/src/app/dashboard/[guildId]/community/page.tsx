'use client';

import { useParams } from 'next/navigation';
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@pavisie/ui';
import { AnnouncementsTab } from '@/components/dashboard/community/announcements-tab';
import { BirthdaysTab } from '@/components/dashboard/community/birthdays-tab';
import { ChannelsTab } from '@/components/dashboard/community/channels-tab';
import { EventsTab } from '@/components/dashboard/community/events-tab';
import { GiveawaysTab } from '@/components/dashboard/community/giveaways-tab';
import { OverviewTab } from '@/components/dashboard/community/overview-tab';
import { PollsTab } from '@/components/dashboard/community/polls-tab';
import { SuggestionsTab } from '@/components/dashboard/community/suggestions-tab';
import { TagsTab } from '@/components/dashboard/community/tags-tab';

export default function CommunityPage() {
  const { guildId } = useParams<{ guildId: string }>();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Community"
        description="Polls, giveaways, the suggestion box, scheduled announcements, events, tags (custom commands / auto-responders), channel automations (sticky messages, auto-publish, auto-threads, server-stats channels), and birthdays."
      />

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="suggestions">Suggestions</TabsTrigger>
          <TabsTrigger value="giveaways">Giveaways</TabsTrigger>
          <TabsTrigger value="polls">Polls</TabsTrigger>
          <TabsTrigger value="announcements">Announcements</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="tags">Tags</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="birthdays">Birthdays</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="suggestions">
          <SuggestionsTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="giveaways">
          <GiveawaysTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="polls">
          <PollsTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="announcements">
          <AnnouncementsTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="events">
          <EventsTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="tags">
          <TagsTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="channels">
          <ChannelsTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="birthdays">
          <BirthdaysTab guildId={guildId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
