'use client';

import { useParams } from 'next/navigation';
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@pavisie/ui';
import { TicketsPanelsTab } from '@/components/dashboard/tickets/panels-tab';
import { TicketsQueueTab } from '@/components/dashboard/tickets/queue-tab';
import { TicketsSettingsTab } from '@/components/dashboard/tickets/settings-tab';

export default function TicketsPage() {
  const { guildId } = useParams<{ guildId: string }>();

  return (
    <div className="space-y-6">
      <PageHeader title="Tickets" description="Support panels, the ticket queue, and transcripts." />

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Queue</TabsTrigger>
          <TabsTrigger value="panels">Panels</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="queue">
          <TicketsQueueTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="panels">
          <TicketsPanelsTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="settings">
          <TicketsSettingsTab guildId={guildId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
