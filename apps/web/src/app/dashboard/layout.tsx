'use client';

import * as React from 'react';
import { Skeleton } from '@pavisie/ui';
import { useSession } from '@/lib/dashboard/session';
import { API_BASE_URL } from '@/lib/dashboard/api';

/**
 * Auth gate for the entire `/dashboard` tree. Unauthenticated visitors go straight into the Discord
 * OAuth flow, whose callback returns them to `/dashboard`.
 *
 * They are deliberately NOT sent to `/`: there is no sign-in control anywhere on the site, so
 * bouncing them to the homepage left "Open dashboard" as a dead end with no way to log in. The
 * middleware does the same check at the edge; this one is authoritative, because a present `sid`
 * cookie does not prove the session is still valid server-side.
 */
export default function DashboardRootLayout({ children }: { children: React.ReactNode }) {
  const { status } = useSession();

  React.useEffect(() => {
    if (status === 'unauthenticated') {
      // Full page navigation, not router.replace — this leaves the app for the API's OAuth origin.
      window.location.href = `${API_BASE_URL}/auth/discord/login`;
    }
  }, [status]);

  if (status === 'loading') {
    return (
      <div className="min-h-dvh bg-background text-foreground">
        <div className="mx-auto max-w-5xl space-y-4 p-6">
          <Skeleton className="h-8 w-48" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return null;
  }

  // `bg-background text-foreground` here (not just in `[guildId]/layout.tsx`) so every page under
  // `/dashboard` — including the guild-picker root page, which this layout also wraps — gets the
  // dashboard's shadcn-token surface instead of the marketing root layout's dark `ink-0` body
  // showing through in the (light-theme) case.
  return <div className="min-h-dvh bg-background text-foreground">{children}</div>;
}
