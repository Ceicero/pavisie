import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ThreatIncidentDto } from '@pavisie/types';
import { NAV, isNavItemDisabled } from '../src/components/dashboard/nav';
import { canOpenCaseDrawer, threatsQueryKeys } from '../src/lib/dashboard/threats-queries';
import {
  NO_ACTIVE_THREATS_MESSAGE,
  THREAT_KIND_LABEL,
  threatIncidentDetails,
} from '../src/components/dashboard/threats/live-incidents-panel';

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

  it('the threats panel polls via useThreatIncidents and shows the honest empty state', () => {
    const panel = sourceOf('../src/components/dashboard/threats/live-incidents-panel.tsx');
    const queries = sourceOf('../src/lib/dashboard/threats-queries.ts');
    const page = sourceOf('../src/app/dashboard/[guildId]/threats/page.tsx');
    expect(panel).toContain('useThreatIncidents');
    expect(panel).toContain('ErrorState');
    expect(panel).toContain('NO_ACTIVE_THREATS_MESSAGE');
    expect(NO_ACTIVE_THREATS_MESSAGE).toBe('No active threats. Raid detection is coming soon.');
    expect(panel).toContain('>Threats<');
    expect(panel).not.toContain('Live threats');
    expect(panel).not.toContain('No live raid or threat incidents');
    expect(panel).not.toMatch(/monitoring/i);
    expect(panel).not.toMatch(/animate-pulse|green-pulse/);
    expect(panel).not.toContain('Updates every 15 seconds');
    expect(page).not.toContain('Live raid');
    expect(queries).toContain('refetchInterval: 15_000');
    expect(queries).toContain('/threats/incidents');
    expect(queries).toContain('/threats/audit');
  });

  it('renders incident-card details when fixtures are injected', () => {
    const panel = sourceOf('../src/components/dashboard/threats/live-incidents-panel.tsx');
    expect(panel).toContain('<IncidentCard key={incident.id} incident={incident} />');

    const raid: ThreatIncidentDto = {
      id: 'raid-active-g1',
      guildId: 'g1',
      kind: 'raid',
      status: 'active',
      ruleName: 'Join burst',
      dryRun: false,
      startedAt: '2026-11-13T20:00:00.000Z',
      lastActivityAt: '2026-11-13T20:04:12.000Z',
      joinsFlagged: 47,
    };
    const burst: ThreatIncidentDto = {
      id: 'message-burst-active-g1',
      guildId: 'g1',
      kind: 'message_burst',
      status: 'active',
      ruleName: 'Caps filter',
      dryRun: false,
      startedAt: '2026-11-13T20:03:00.000Z',
      lastActivityAt: '2026-11-13T20:04:50.000Z',
      matches: 18,
      members: 4,
      channelId: '1400000000000000000',
    };
    const lockdown: ThreatIncidentDto = {
      id: 'lockdown-ended-g1',
      guildId: 'g1',
      kind: 'lockdown',
      status: 'ended',
      ruleName: 'Join burst',
      dryRun: false,
      startedAt: '2026-11-13T17:00:00.000Z',
      lastActivityAt: '2026-11-13T17:20:00.000Z',
      endedAt: '2026-11-13T17:20:00.000Z',
      lockdownAction: 'raise-verification',
    };

    expect(threatIncidentDetails(raid)).toEqual([{ label: 'Joins flagged', value: '47' }]);
    expect(threatIncidentDetails(burst)).toEqual([
      { label: 'Matches', value: '+18' },
      { label: 'Members', value: '4' },
      { label: 'Channel', value: '1400000000000000000' },
    ]);
    expect(threatIncidentDetails(lockdown)).toEqual([
      { label: 'Action', value: 'raise-verification' },
    ]);
    expect(THREAT_KIND_LABEL[raid.kind]).toBe('Raid');
    expect(THREAT_KIND_LABEL[burst.kind]).toBe('Message burst');
    expect(THREAT_KIND_LABEL[lockdown.kind]).toBe('Lockdown');
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
