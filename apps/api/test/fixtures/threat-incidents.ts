import type { ThreatIncidentDto } from '@pavisie/types';

/**
 * Test-only threat-incident fixtures. Never imported from production code.
 * Timestamps are fixed so assertions stay stable.
 */
export function threatIncidentFixtures(guildId: string): ThreatIncidentDto[] {
  return [
    {
      id: `raid-active-${guildId}`,
      guildId,
      kind: 'raid',
      status: 'active',
      ruleId: 'stub-raid-rule',
      ruleName: 'Join burst',
      dryRun: false,
      startedAt: '2026-11-13T20:00:00.000Z',
      lastActivityAt: '2026-11-13T20:04:12.000Z',
      joinsFlagged: 47,
    },
    {
      id: `raid-ended-${guildId}`,
      guildId,
      kind: 'raid',
      status: 'ended',
      ruleId: 'stub-raid-rule',
      ruleName: 'Join burst',
      dryRun: true,
      startedAt: '2026-11-13T18:10:00.000Z',
      lastActivityAt: '2026-11-13T18:12:41.000Z',
      endedAt: '2026-11-13T18:13:41.000Z',
      joinsFlagged: 12,
    },
    {
      id: `message-burst-active-${guildId}`,
      guildId,
      kind: 'message_burst',
      status: 'active',
      ruleId: 'stub-caps-rule',
      ruleName: 'Caps filter',
      dryRun: false,
      startedAt: '2026-11-13T20:03:00.000Z',
      lastActivityAt: '2026-11-13T20:04:50.000Z',
      matches: 18,
      members: 4,
      channelId: '1400000000000000000',
    },
    {
      id: `lockdown-ended-${guildId}`,
      guildId,
      kind: 'lockdown',
      status: 'ended',
      ruleId: 'stub-raid-rule',
      ruleName: 'Join burst',
      dryRun: false,
      startedAt: '2026-11-13T17:00:00.000Z',
      lastActivityAt: '2026-11-13T17:20:00.000Z',
      endedAt: '2026-11-13T17:20:00.000Z',
      lockdownAction: 'raise-verification',
    },
  ];
}

export async function fixtureThreatIncidentSource(guildId: string): Promise<ThreatIncidentDto[]> {
  return threatIncidentFixtures(guildId);
}
