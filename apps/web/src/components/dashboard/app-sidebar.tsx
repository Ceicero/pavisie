'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MessageCircle } from 'lucide-react';
import { Sidebar, SidebarNavItem, SidebarSection, Badge } from '@pavisie/ui';
import { NAV, isNavItemActive, isNavItemDisabled } from './nav';
import { BrandWordmark } from './brand-wordmark';
import { usePlugins } from '@/lib/dashboard/queries';
import { supportServerUrl } from '@/lib/site';

export interface AppSidebarProps {
  guildId: string;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
}

/**
 * Per-guild dashboard sidebar: the static nav from `NAV`, dimming plugin sections that are
 * disabled. The guild switcher used to live in this sidebar's header; it moved to the site-wide
 * `TopBar` (`apps/web/src/components/TopBar.tsx`) so there's exactly one switcher on screen
 * instead of two identical ones stacked (top bar + sidebar) on every guild page.
 */
export function AppSidebar({ guildId, mobileOpen, onMobileOpenChange }: AppSidebarProps) {
  const pathname = usePathname();
  const { data: plugins } = usePlugins(guildId);
  const support = supportServerUrl();

  return (
    <Sidebar
      mobileOpen={mobileOpen}
      onMobileOpenChange={onMobileOpenChange}
      header={<BrandWordmark />}
      footer={
        support ? (
          <SidebarNavItem icon={<MessageCircle />} href={support} target="_blank" rel="noopener noreferrer">
            Get help on Discord
          </SidebarNavItem>
        ) : undefined
      }
    >
      <SidebarSection>
        {NAV.map((item) => {
          const href = item.href(guildId);
          const active = isNavItemActive(pathname, href);
          const disabled = isNavItemDisabled(item, plugins);

          return (
            <SidebarNavItem
              key={href}
              asChild
              active={active}
              icon={<item.icon />}
              suffix={
                disabled ? (
                  <Badge variant="outline" className="text-[10px]">
                    Off
                  </Badge>
                ) : undefined
              }
            >
              <Link href={href} onClick={() => onMobileOpenChange(false)}>
                <span className="flex-1 truncate">{item.label}</span>
              </Link>
            </SidebarNavItem>
          );
        })}
      </SidebarSection>
    </Sidebar>
  );
}
