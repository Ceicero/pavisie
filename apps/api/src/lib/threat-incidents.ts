/**
 * Live raid / threat incident source for `GET /guilds/:guildId/threats/incidents`.
 *
 * THIS FILE IS THE ADAPTER. The dashboard and the route always call
 * `listThreatIncidents`. Today it returns a typed, deterministic mock so the
 * Threat overview's live-incidents panel can be built against
 * `ThreatIncidentDto` before Claude's raid-mode API exists.
 *
 * When that API lands, replace the body of `listThreatIncidents` with a call
 * to it (same return type). Do not read automod Redis raid-alert keys from
 * here — those are owned by the automod plugin and are not the contract.
 *
 * No Redis. No Prisma. No schema change.
 */
import type { ThreatIncidentDto } from '@pavisie/types';

/**
 * Returns the current threat incidents for `guildId`.
 *
 * The mock always returns the same three incidents, stamped with the
 * requested `guildId`, so every guild's dashboard has something to render
 * while the real source is missing. Timestamps are fixed (not `Date.now()`)
 * so tests and screenshots stay stable.
 */
export async function listThreatIncidents(guildId: string): Promise<ThreatIncidentDto[]> {
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
  ];
}
