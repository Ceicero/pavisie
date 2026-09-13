'use client';

import { usePathname } from 'next/navigation';
import { Smoke } from './Smoke';
import { Grain } from './Grain';
import { Footer } from './Footer';
import { TopBar } from './TopBar';

/**
 * The whole app shell: `TopBar` on every page, plus the marketing-only smoke/grain background
 * effects and footer, gated on route. Dashboard pages get neither: their own opaque
 * `@pavisie/ui` surfaces (`bg-background`, sidebar `bg-card`, ...) aren't designed to sit over
 * the smoky/grainy marketing background, and the dashboard has no use for the marketing footer.
 *
 * Smoke/Grain stay outside `.site-content` and Footer stays inside it (after `<main>`), matching
 * the original marketing layout's DOM order exactly: `.site-content`'s `position: relative;
 * z-index: 2` (globals.css) is what lifts foreground content — including the footer — above the
 * fixed, low-z-index smoke (`z-0`) and grain (`z-1`) layers, so the footer only gets that
 * stacking context by staying inside this div, not by being a sibling appended after it.
 */
export function SiteChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isDashboard = pathname?.startsWith('/dashboard') ?? false;

  return (
    <>
      {!isDashboard && <Smoke />}
      {!isDashboard && <Grain />}
      <div className="site-content flex min-h-dvh flex-col">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-paper focus:px-4 focus:py-2 focus:text-ink-0"
        >
          Skip to content
        </a>
        <TopBar />
        <main id="main-content" className="flex-1">
          {children}
        </main>
        {!isDashboard && <Footer />}
      </div>
    </>
  );
}
