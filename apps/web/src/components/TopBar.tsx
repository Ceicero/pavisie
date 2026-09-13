'use client';

import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';
import { Menu, LogOut, User as UserIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
} from '@pavisie/ui';
import { Logo } from './Logo';
import { ButtonLink } from './Button';
import { GuildSwitcher } from './dashboard/guild-switcher';
import { ThemeToggle } from './dashboard/theme-toggle';
import { useSession } from '@/lib/dashboard/session';
import { inviteUrl } from '@/lib/site';

/** The site's info pages, reachable from the hamburger on every page (dashboard included), and —
 * outside the dashboard — also shown inline on desktop, matching the old marketing `Nav`. */
const SITE_LINKS = [
  { href: '/features', label: 'Commands' },
  { href: '/enforcer', label: 'Enforcer' },
  { href: '/staff-roles', label: 'Staff roles' },
  { href: '/donate', label: 'Donate' },
  { href: '/support', label: 'Support' },
];

/**
 * Single persistent top bar for the whole app — marketing pages and the dashboard alike. Replaces
 * the old marketing-only `Nav` and the old per-guild dashboard `TopBar` (both deleted). Brandon's
 * explicit ask: getting back to the site's info pages from inside the dashboard should be smooth,
 * and there must be exactly one hamburger (not a marketing one and a separate dashboard one).
 *
 * `h-14 z-30` matches the old dashboard `TopBar` exactly (not the old marketing `Nav`'s `z-40`) —
 * `DashboardTabStrip` (`components/dashboard/dashboard-tab-strip.tsx`) is `sticky top-14 z-20` and
 * depends on that specific height/stacking to sit flush beneath this bar without a gap and below
 * it in the stack.
 *
 * - The brand mark always links home.
 * - The guild switcher shows only on `/dashboard/[guildId]/**` routes. It used to live in the
 *   sidebar header (`components/dashboard/app-sidebar.tsx`); it moved here so there's exactly one
 *   switcher on screen instead of two identical ones stacked on every guild page.
 * - The theme toggle and account menu are dashboard-only: they read session/theme state that
 *   `Providers` only makes meaningful once a user can be signed in, and marketing pages have no
 *   equivalent concept. The marketing "Open dashboard"/"Add to Discord" CTAs and inline link row
 *   are the mirror image, shown only outside the dashboard.
 * - The one hamburger opens a single flat menu of the site's info pages (`SITE_LINKS`:
 *   Commands/Enforcer/Support/Donate) on every page, dashboard included — its one job is getting
 *   back to the rest of the site. It used to also list the 16 dashboard sections in a "This
 *   server" group, but that was redundant: those sections are always reachable via `AppSidebar`
 *   (`lg` and up) or `DashboardTabStrip` (below `lg`, sticky beneath this bar), so the group was
 *   dropped. It replaces the old dashboard `TopBar`'s mobile-only hamburger, which just toggled
 *   the sidebar's slide-in Sheet — now redundant with `DashboardTabStrip`. `AppSidebar`'s Sheet is
 *   left wired but nothing opens it anymore; see that file's doc comment.
 */
export function TopBar() {
  const pathname = usePathname();
  const params = useParams<{ guildId?: string }>();
  const inDashboard = pathname?.startsWith('/dashboard') ?? false;
  const guildId = inDashboard ? params?.guildId : undefined;
  const invite = inviteUrl();

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:px-6">
      <Logo imageSize={28} />

      {guildId ? (
        // `GuildSwitcher`'s trigger is `w-full` (sized for its old home filling the sidebar
        // column); constrain the wrapper here so it doesn't try to fill this flex row instead.
        <div className="min-w-0 max-w-[10rem] sm:max-w-xs">
          <GuildSwitcher currentGuildId={guildId} />
        </div>
      ) : null}

      {!inDashboard ? (
        <nav aria-label="Primary" className="hidden items-center gap-6 md:flex">
          {SITE_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded text-sm text-grey-3 transition-colors hover:text-grey-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grey-5"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        {!inDashboard ? (
          <>
            <ButtonLink href="/dashboard" variant="ghost" size="md" className="hidden sm:inline-flex">
              Open dashboard
            </ButtonLink>
            {invite ? (
              <ButtonLink href={invite} external variant="primary" size="md">
                Add to Discord
              </ButtonLink>
            ) : (
              <ButtonLink href="/features" variant="primary" size="md">
                Explore features
              </ButtonLink>
            )}
          </>
        ) : null}

        {inDashboard ? <ThemeToggle /> : null}
        {inDashboard ? <AccountMenu /> : null}

        <HamburgerMenu />
      </div>
    </header>
  );
}

/** Dashboard-only avatar dropdown + logout — moved here verbatim from the old per-guild `TopBar`. */
function AccountMenu() {
  const { user, logout } = useSession();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-full focus:outline-none focus:ring-2 focus:ring-ring">
        {user?.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
            <UserIcon className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate">{user?.globalName ?? user?.username ?? 'Account'}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut className="h-4 w-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The one hamburger: a flat list of `SITE_LINKS`, always. No group label — a lone
 * `DropdownMenuLabel` above one short list reads as clutter, not a group, since there's nothing
 * else in the menu for it to distinguish. Previously also listed the 16 dashboard sections in a
 * "This server" group when inside a guild; that was redundant with `AppSidebar`/
 * `DashboardTabStrip` and was removed (see `TopBar`'s doc comment).
 */
function HamburgerMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Open menu" variant="ghost">
          <Menu className="h-5 w-5" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {SITE_LINKS.map((link) => (
          <DropdownMenuItem asChild key={link.href}>
            <Link href={link.href}>{link.label}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
