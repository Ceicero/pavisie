import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PluginSummary } from '@pavisie/types';
import { QUICK_LINKS, visibleQuickLinks } from '../src/app/dashboard/[guildId]/page';

function makePlugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'moderation',
    name: 'Moderation',
    description: '',
    category: 'moderation',
    version: '1.0.0',
    enabled: true,
    defaultEnabled: true,
    ...overrides,
  } as PluginSummary;
}

describe('overview quick links', () => {
  it('always includes Manage plugins, which is not gated on a plugin', () => {
    const manage = QUICK_LINKS.find((link) => link.href === 'plugins');
    expect(manage?.label).toBe('Manage plugins');
    expect(manage?.pluginId).toBeUndefined();
    expect(visibleQuickLinks([]).map((link) => link.href)).toContain('plugins');
    expect(
      visibleQuickLinks([
        makePlugin({ id: 'moderation', enabled: false }),
        makePlugin({ id: 'automod', enabled: false }),
        makePlugin({ id: 'tickets', enabled: false }),
      ]).map((link) => link.href),
    ).toEqual(['plugins']);
  });

  it('hides Moderation, Automod, and Tickets when that plugin is disabled', () => {
    const enabled = [
      makePlugin({ id: 'moderation', enabled: true }),
      makePlugin({ id: 'automod', enabled: true }),
      makePlugin({ id: 'tickets', enabled: true }),
    ];
    expect(visibleQuickLinks(enabled).map((link) => link.href)).toEqual([
      'plugins',
      'moderation',
      'automod',
      'tickets',
    ]);

    expect(
      visibleQuickLinks([
        makePlugin({ id: 'moderation', enabled: false }),
        makePlugin({ id: 'automod', enabled: true }),
        makePlugin({ id: 'tickets', enabled: true }),
      ]).map((link) => link.href),
    ).toEqual(['plugins', 'automod', 'tickets']);

    expect(
      visibleQuickLinks([
        makePlugin({ id: 'moderation', enabled: true }),
        makePlugin({ id: 'automod', enabled: false }),
        makePlugin({ id: 'tickets', enabled: false }),
      ]).map((link) => link.href),
    ).toEqual(['plugins', 'moderation']);
  });

  it('shows a plugin-gated link when the plugin list is missing or does not include that plugin', () => {
    expect(visibleQuickLinks(undefined).map((link) => link.href)).toEqual([
      'plugins',
      'moderation',
      'automod',
      'tickets',
    ]);
    expect(visibleQuickLinks([]).map((link) => link.href)).toEqual([
      'plugins',
      'moderation',
      'automod',
      'tickets',
    ]);
  });

  it('filters with isNavItemDisabled from nav.ts and does not edit nav.ts', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../src/app/dashboard/[guildId]/page.tsx', import.meta.url)),
      'utf8',
    );
    const nav = readFileSync(fileURLToPath(new URL('../src/components/dashboard/nav.ts', import.meta.url)), 'utf8');
    expect(page).toContain('isNavItemDisabled');
    expect(page).toContain("from '@/components/dashboard/nav'");
    expect(page).toContain('visibleQuickLinks(plugins)');
    expect(nav).not.toContain('QUICK_LINKS');
    expect(nav).not.toContain('visibleQuickLinks');
  });
});
