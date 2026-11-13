import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV, isNavItemDisabled } from '../src/components/dashboard/nav';
import { canOpenCaseDrawer, threatsQueryKeys } from '../src/lib/dashboard/threats-queries';

function sourceOf(relativeFromTest: string): string {
  return readFileSync(fileURLToPath(new URL(relativeFromTest, import.meta.url)), 'utf8');
}

describe('Threat overview NAV', () => {
  const item = NAV.find((n) => n.label === 'Threat overview');

  it('is its own section immediately after Automod, with no plugin gate', () => {
    expect(item).toBeDefined();
    const labels = NAV.map((n) => n.label);
    expect(labels[labels.indexOf('Automod') + 1]).toBe('Threat overview');
    expect(item!.href('g1')).toBe('/dashboard/g1/threats');
    expect(item!.pluginId).toBeUndefined();
    expect(isNavItemDisabled(item!, undefined)).toBe(false);
  });
});

describe('threats query helpers', () => {
  it('builds stable query keys for audit filters and incidents', () => {
    const filters = { limit: 25, action: 'moderation.case.create' };
    expect(threatsQueryKeys.audit('g1', filters)).toEqual([
      'guilds',
      'g1',
      'threats',
      'audit',
      filters,
    ]);
    expect(threatsQueryKeys.incidents('g1')).toEqual(['guilds', 'g1', 'threats', 'incidents']);
  });

  it('canOpenCaseDrawer is true only for a positive case number', () => {
    expect(canOpenCaseDrawer({ caseNumber: 7 })).toBe(true);
    expect(canOpenCaseDrawer({ caseNumber: 0 })).toBe(false);
    expect(canOpenCaseDrawer({ caseNumber: undefined })).toBe(false);
    expect(canOpenCaseDrawer({})).toBe(false);
  });
});

describe('Threat overview panels (source conventions)', () => {
  it('the audit trail uses cursorStack pagination, the case drawer, and an error toast on a failed case load', () => {
    const src = sourceOf('../src/components/dashboard/threats/audit-trail-panel.tsx');
    expect(src).toContain('cursorStack');
    expect(src).toContain('CaseDetailDrawer');
    expect(src).toContain('canOpenCaseDrawer');
    expect(src).toContain('useThreatAudit');
    expect(src).toContain("title: 'Could not load case'");
    expect(src).toContain('variant: \'destructive\'');
    expect(src).toContain('emptyTitle="No moderation audit entries"');
  });

  it('the live-incidents panel polls via useThreatIncidents and has an empty state', () => {
    const panel = sourceOf('../src/components/dashboard/threats/live-incidents-panel.tsx');
    const queries = sourceOf('../src/lib/dashboard/threats-queries.ts');
    expect(panel).toContain('useThreatIncidents');
    expect(panel).toContain('No live raid or threat incidents');
    expect(panel).toContain('ErrorState');
    expect(queries).toContain('refetchInterval: 15_000');
    expect(queries).toContain('/threats/incidents');
    expect(queries).toContain('/threats/audit');
  });

  it('the page is titled Threat overview and stacks live incidents above the audit trail', () => {
    const src = sourceOf('../src/app/dashboard/[guildId]/threats/page.tsx');
    expect(src).toContain('title="Threat overview"');
    expect(src).toContain('LiveIncidentsPanel');
    expect(src).toContain('AuditTrailPanel');
    const liveAt = src.indexOf('LiveIncidentsPanel');
    const auditAt = src.indexOf('AuditTrailPanel');
    // The first mention of each is an import; the JSX uses come later. Compare last indexes.
    expect(src.lastIndexOf('LiveIncidentsPanel')).toBeLessThan(src.lastIndexOf('AuditTrailPanel'));
    expect(liveAt).toBeGreaterThan(-1);
    expect(auditAt).toBeGreaterThan(-1);
  });
});
