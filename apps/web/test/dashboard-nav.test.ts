import { describe, expect, it } from 'vitest';
import type { PluginSummary } from '@pavisie/types';
import { NAV, isNavItemActive, isNavItemDisabled } from '../src/components/dashboard/nav';
import { AppSidebar } from '../src/components/dashboard/app-sidebar';
import { DashboardTabStrip } from '../src/components/dashboard/dashboard-tab-strip';

function makePlugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'automod',
    name: 'Automod',
    description: '',
    category: 'moderation',
    version: '1.0.0',
    enabled: true,
    defaultEnabled: true,
    ...overrides,
  } as PluginSummary;
}

describe('NAV', () => {
  it('lists all 16 dashboard sections in the documented order', () => {
    expect(NAV.map((item) => item.label)).toEqual([
      'Overview',
      'Plugins',
      'Moderation',
      'Automod',
      'Enforcer',
      'Logging',
      'Tickets',
      'Roles',
      'Engagement',
      'Community',
      'Integrations',
      'AI Assistant',
      'Analytics',
      'Audit log',
      'Privacy',
      'Settings',
    ]);
  });

  it('is the single source both the sidebar and the below-lg tab strip render from', () => {
    // `app-sidebar.tsx` and `dashboard-tab-strip.tsx` must each map over the *same* `NAV`
    // export, and derive "active"/"disabled" from the same `isNavItemActive`/`isNavItemDisabled`
    // helpers, rather than each keeping their own copy of the list or re-deriving that state —
    // read their source rather than rendering (no jsdom/React Testing Library in this app's test
    // setup) so this still catches someone reintroducing a second, divergent nav array or a
    // one-off `pathname === href` check that could drift from the shared definition.
    // Note: under vitest's SSR transform, destructured imports get rewritten to
    // `(0,__vite_ssr_import_N__.isNavItemActive)(...)`, so match on the bare identifier rather
    // than assuming it's followed directly by `(`.
    for (const src of [AppSidebar.toString(), DashboardTabStrip.toString()]) {
      expect(src).toContain('NAV.map');
      expect(src).toContain('isNavItemActive');
      expect(src).toContain('isNavItemDisabled');
    }
  });
});

describe('isNavItemActive', () => {
  const item = NAV.find((n) => n.label === 'Automod')!;
  const href = item.href('123');

  it('is true only when the pathname exactly matches the item\'s href', () => {
    expect(isNavItemActive(href, href)).toBe(true);
  });

  it('is false for a sub-route of the item (e.g. a detail page under it)', () => {
    expect(isNavItemActive(`${href}/rules`, href)).toBe(false);
  });

  it('is false for an unrelated route', () => {
    expect(isNavItemActive('/dashboard/123/settings', href)).toBe(false);
  });

  it('is false when pathname is null (usePathname before mount/hydration)', () => {
    expect(isNavItemActive(null, href)).toBe(false);
  });

  it('marks exactly one NAV item active for a given pathname, matching what the tab strip and sidebar each render as the current section', () => {
    const pathname = NAV[3].href('g1');
    const activeCount = NAV.filter((n) => isNavItemActive(pathname, n.href('g1'))).length;
    expect(activeCount).toBe(1);
  });
});

describe('isNavItemDisabled', () => {
  const item = NAV.find((n) => n.label === 'Automod')!;
  const unguardedItem = NAV.find((n) => n.label === 'Overview')!;

  it('is false for nav items with no pluginId, regardless of plugin state', () => {
    expect(isNavItemDisabled(unguardedItem, [makePlugin({ id: 'automod', enabled: false })])).toBe(false);
  });

  it('is false when the gating plugin is enabled', () => {
    expect(isNavItemDisabled(item, [makePlugin({ id: 'automod', enabled: true })])).toBe(false);
  });

  it('is true when the gating plugin is disabled — this is what drives the "Off" badge on both surfaces', () => {
    expect(isNavItemDisabled(item, [makePlugin({ id: 'automod', enabled: false })])).toBe(true);
  });

  it('is false (not true) when plugin data has not loaded yet, so nothing flashes "Off" before data arrives', () => {
    expect(isNavItemDisabled(item, undefined)).toBe(false);
  });

  it('is false when the plugin list loaded but does not include this item\'s plugin', () => {
    expect(isNavItemDisabled(item, [makePlugin({ id: 'roles', enabled: false })])).toBe(false);
  });
});
