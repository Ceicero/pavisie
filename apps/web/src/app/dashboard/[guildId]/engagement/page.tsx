'use client';

import { useParams } from 'next/navigation';
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@pavisie/ui';
import { LevelingTab } from '@/components/dashboard/engagement/leveling-tab';
import { ReputationTab } from '@/components/dashboard/engagement/reputation-tab';
import { StarboardTab } from '@/components/dashboard/engagement/starboard-tab';
import { TempVoiceTab } from '@/components/dashboard/engagement/tempvoice-tab';

export default function EngagementPage() {
  const { guildId } = useParams<{ guildId: string }>();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Engagement"
        description="Leveling and XP, reputation, the starboard, and temporary voice channels."
      />

      <Tabs defaultValue="leveling">
        <TabsList>
          <TabsTrigger value="leveling">Leveling</TabsTrigger>
          <TabsTrigger value="reputation">Reputation</TabsTrigger>
          <TabsTrigger value="starboard">Starboard</TabsTrigger>
          <TabsTrigger value="tempvoice">Temp voice</TabsTrigger>
        </TabsList>

        <TabsContent value="leveling">
          <LevelingTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="reputation">
          <ReputationTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="starboard">
          <StarboardTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="tempvoice">
          <TempVoiceTab guildId={guildId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
