'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@pavisie/ui';
import { SessionProvider } from '@/lib/dashboard/session';

/**
 * Root client-side providers for the whole merged app (marketing pages and the dashboard alike),
 * mounted once in the root layout so the single `TopBar` can show session/theme-aware controls
 * (account menu, theme toggle) without a second provider tree nested under `/dashboard`.
 *
 * Mounting this above the marketing routes too means every page (not just `/dashboard/**`) fires
 * a background `GET /auth/me` on load and gets `next-themes`' `class` attribute management on
 * `<html>` — a deliberate trade-off for "one top bar everywhere" rather than a per-route split.
 * It does not affect static prerendering (client component wrapping doesn't force a page
 * dynamic) and does not affect the marketing look (which is dark-by-default via the
 * `html[data-theme='light']` selectors in `globals.css`, a different attribute than `next-themes`'
 * `class` toggle, so the two never interact).
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          {children}
          <Toaster />
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
