'use client';

import { PageHeader, Card, CardContent } from '@pavisie/ui';
import { BrandWordmark } from '../components/brand-wordmark';
import { ThemeToggle } from '../components/theme-toggle';
import { useSession } from '../lib/session';

/**
 * Root page for this service (`app.pavisie.com`). `/` and `/dashboard/**` redirect to the
 * website (see `next.config.ts`); this renders only for requests that are not redirected.
 * It shows real session state and the theme control. It does not invent ops content.
 */
export default function RootPage() {
  const { status, user } = useSession();

  const sessionLabel =
    status === 'authenticated' && user
      ? `Signed in as ${user.globalName ?? user.username}`
      : status === 'loading'
        ? 'Checking session…'
        : 'Not signed in';

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
      <div className="flex items-center justify-between gap-4">
        <BrandWordmark />
        <ThemeToggle />
      </div>
      <PageHeader
        className="pb-0"
        title="Pavisie"
        description="This page confirms your sign-in. Server configuration lives on the main site."
      />
      <Card>
        <CardContent className="p-4">
          <p role="status" className="text-sm text-muted-foreground">
            {sessionLabel}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
