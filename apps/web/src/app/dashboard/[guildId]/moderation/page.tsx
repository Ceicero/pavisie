'use client';

import { useParams } from 'next/navigation';
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@pavisie/ui';
import { AppealsTab } from '@/components/dashboard/moderation/appeals-tab';
import { CasesTab } from '@/components/dashboard/moderation/cases-tab';
import { SettingsTab } from '@/components/dashboard/moderation/settings-tab';
import { WarningsTab } from '@/components/dashboard/moderation/warnings-tab';

export default function ModerationPage() {
  const { guildId } = useParams<{ guildId: string }>();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Moderation"
        description="Case viewer, warnings, appeals, and moderation settings for this server."
      />

      <Tabs defaultValue="cases">
        <TabsList>
          <TabsTrigger value="cases">Cases</TabsTrigger>
          <TabsTrigger value="warnings">Warnings</TabsTrigger>
          <TabsTrigger value="appeals">Appeals</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="cases" className="mt-4">
          <CasesTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="warnings" className="mt-4">
          <WarningsTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="appeals" className="mt-4">
          <AppealsTab guildId={guildId} />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab guildId={guildId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
