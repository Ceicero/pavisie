'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { AppSidebar } from '@/components/dashboard/app-sidebar';
import { DashboardTabStrip } from '@/components/dashboard/dashboard-tab-strip';

/**
 * Sidebar + tab-strip shell wrapping every `/dashboard/[guildId]/*` page. The per-guild top bar
 * that used to live here was consolidated into the single site-wide `TopBar`
 * (`apps/web/src/components/TopBar.tsx`, mounted once in the root layout) — see that file's doc
 * comment for why. `AppSidebar`'s `mobileOpen` Sheet is effectively superseded by
 * `DashboardTabStrip` (which already gives every breakpoint below `lg` a way to reach all 16
 * sections), so nothing opens it anymore; it's kept wired (rather than ripped out of
 * `AppSidebar`, a shared/reused component) since leaving it permanently closed is harmless.
 *
 * Height is the viewport minus the site `TopBar` (`h-14`). A full `min-h-dvh` here sits inside
 * that bar and forces an extra screenful of scroll. The page region is a `div`, not a second
 * `<main>` — `SiteChrome` already owns the landmark.
 */
export default function GuildLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ guildId: string }>();
  const guildId = params.guildId;
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)]">
      <AppSidebar guildId={guildId} mobileOpen={mobileOpen} onMobileOpenChange={setMobileOpen} />
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardTabStrip guildId={guildId} />
        <div className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</div>
      </div>
    </div>
  );
}
