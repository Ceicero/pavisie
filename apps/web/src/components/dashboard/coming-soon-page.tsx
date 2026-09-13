import { Construction } from 'lucide-react';
import { EmptyState, PageHeader } from '@pavisie/ui';

export interface ComingSoonPageProps {
  title: string;
  description: string;
}

/** Shared shell for plugin sections not yet built out in the dashboard. Replaced page-by-page by later build stages. */
export function ComingSoonPage({ title, description }: ComingSoonPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={<Construction />}
        title="This section is built in the next stage"
        description="Check back soon — this page will get its full dashboard experience in an upcoming build."
      />
    </div>
  );
}
