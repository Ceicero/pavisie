import { Puzzle, Gavel, ShieldAlert, LifeBuoy, type LucideIcon } from 'lucide-react';
import type { PluginId, PluginSummary } from '@pavisie/types';
import { isNavItemDisabled, type NavItem } from './nav';

export const QUICK_LINKS: {
  href: string;
  label: string;
  icon: LucideIcon;
  pluginId?: PluginId;
}[] = [
  { href: 'plugins', label: 'Manage plugins', icon: Puzzle },
  { href: 'moderation', label: 'Moderation cases', icon: Gavel, pluginId: 'moderation' },
  { href: 'automod', label: 'Automod rules', icon: ShieldAlert, pluginId: 'automod' },
  { href: 'tickets', label: 'Ticket queue', icon: LifeBuoy, pluginId: 'tickets' },
];

function pluginNavItem(pluginId: PluginId | undefined): NavItem {
  return { href: () => '', label: '', icon: Puzzle, pluginId };
}

/** Quick links minus plugin-gated entries whose plugin is disabled. "Manage plugins" has no pluginId and always stays. */
export function visibleQuickLinks(plugins: PluginSummary[] | undefined) {
  return QUICK_LINKS.filter((link) => !isNavItemDisabled(pluginNavItem(link.pluginId), plugins));
}
