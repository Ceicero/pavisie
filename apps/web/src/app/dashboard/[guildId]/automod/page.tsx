'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@pavisie/ui';
import { ReviewQueueTab } from '@/components/dashboard/automod/review-queue-tab';
import { RuleListTab } from '@/components/dashboard/automod/rule-list';
import { SettingsTab } from '@/components/dashboard/automod/settings-tab';

export default function AutomodPage() {
  return (
    <Tabs defaultValue="rules" className="space-y-4">
      <TabsList>
        <TabsTrigger value="rules">Rules</TabsTrigger>
        <TabsTrigger value="review">Review queue</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="rules">
        <RuleListTab />
      </TabsContent>
      <TabsContent value="review">
        <ReviewQueueTab />
      </TabsContent>
      <TabsContent value="settings">
        <SettingsTab />
      </TabsContent>
    </Tabs>
  );
}
