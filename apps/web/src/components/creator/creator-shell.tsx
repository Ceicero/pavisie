'use client';

import * as React from 'react';
import { CreatorSessionProvider } from '@/lib/creator/session';

/**
 * Client shell for the whole `/creator/**` tree: mounts the creator session provider (its own `GET /creator/me`,
 * separate from the Discord dashboard's `SessionProvider` in the root layout) and gives the tree the same
 * `bg-background text-foreground` surface the Discord dashboard uses. Unlike `app/dashboard/layout.tsx` there is
 * NO redirect-to-login gate here: `/creator` is also the public landing page a signed-out streamer sees.
 */
export function CreatorShell({ children }: { children: React.ReactNode }) {
  return (
    <CreatorSessionProvider>
      <div className="min-h-dvh bg-background text-foreground">{children}</div>
    </CreatorSessionProvider>
  );
}
