/**
 * Live raid / threat incident source for `GET /guilds/:guildId/threats/incidents`.
 *
 * THIS FILE IS THE ADAPTER — the single swap point for raid mode's incidents.
 *
 * Production reads raid mode's `RaidModeIncident` table and maps each row to the `ThreatIncidentDto` contract in
 * `@pavisie/types` (threats.ts), which is unchanged: one `raid` incident per raid, plus one `lockdown` incident
 * when a lockdown was applied. Only counts and timestamps come back; per-member scores are on their own route
 * (`/raid-mode/incidents/:incidentId/members`). Do not read automod Redis raid-alert keys from here — those are
 * owned by the automod plugin and are not the contract.
 *
 * Tests inject a fixture source via `setThreatIncidentSourceForTests`. That setter is test-only and is not used
 * on any production path. There is no env flag. Called without a Prisma client (old callers), it returns [].
 */
import type { PrismaClient, RaidModeIncident } from '@pavisie/database';
import type { ThreatIncidentDto } from '@pavisie/types';

/** A source of threat incidents for a guild. */
export type ThreatIncidentSource = (guildId: string) => Promise<ThreatIncidentDto[]>;

let injectedSource: ThreatIncidentSource | undefined;

/** Ended incidents stay on the overview this long; active ones and unrestored lockdowns always show. */
const RECENT_MS = 24 * 60 * 60 * 1000;
const MAX_INCIDENTS = 20;

/** The name shown for raid mode incidents. Raid mode has no automod rule, so `ruleId` is left out. */
export const RAID_MODE_RULE_NAME = 'Raid mode';

function lockdownStillOn(row: Pick<RaidModeIncident, 'lockdownState'>): boolean {
  return row.lockdownState === 'LOCKED' || row.lockdownState === 'PARTIALLY_RESTORED';
}

/** Maps one raid mode incident to its `raid` DTO and, if a lockdown was applied, its `lockdown` DTO. */
export function raidModeIncidentToThreatDtos(row: RaidModeIncident): ThreatIncidentDto[] {
  const raid: ThreatIncidentDto = {
    id: row.id,
    guildId: row.guildId,
    kind: 'raid',
    status: row.status === 'ACTIVE' ? 'active' : 'ended',
    ruleName: RAID_MODE_RULE_NAME,
    dryRun: row.dryRun,
    startedAt: row.startedAt.toISOString(),
    lastActivityAt: (row.endedAt ?? row.lastJoinAt).toISOString(),
    ...(row.endedAt ? { endedAt: row.endedAt.toISOString() } : {}),
    joinsFlagged: row.joinsFlagged,
  };
  if (!row.lockdownAppliedAt) return [raid];
  const on = lockdownStillOn(row);
  const lockdown: ThreatIncidentDto = {
    id: `${row.id}:lockdown`,
    guildId: row.guildId,
    kind: 'lockdown',
    status: on ? 'active' : 'ended',
    ruleName: RAID_MODE_RULE_NAME,
    // A lockdown is a real action even when the raid's detection ran in dry-run (an admin pressed the button).
    dryRun: false,
    startedAt: row.lockdownAppliedAt.toISOString(),
    lastActivityAt: (row.lockdownRestoredAt ?? row.lockdownAppliedAt).toISOString(),
    ...(!on && row.lockdownRestoredAt ? { endedAt: row.lockdownRestoredAt.toISOString() } : {}),
    lockdownAction: row.lockdownActions.join(', '),
  };
  return [raid, lockdown];
}

async function raidModeSource(prisma: PrismaClient, guildId: string): Promise<ThreatIncidentDto[]> {
  const rows = await prisma.raidModeIncident.findMany({
    where: {
      guildId,
      OR: [
        { status: 'ACTIVE' },
        { lockdownState: { in: ['LOCKED', 'PARTIALLY_RESTORED'] } },
        { startedAt: { gte: new Date(Date.now() - RECENT_MS) } },
      ],
    },
    orderBy: { startedAt: 'desc' },
    take: MAX_INCIDENTS,
  });
  return rows.flatMap(raidModeIncidentToThreatDtos);
}

/** Returns the current threat incidents for `guildId`. */
export async function listThreatIncidents(
  guildId: string,
  prisma?: PrismaClient,
): Promise<ThreatIncidentDto[]> {
  if (injectedSource) return injectedSource(guildId);
  if (!prisma) return [];
  return raidModeSource(prisma, guildId);
}

/**
 * Test-only. Replaces the incident source used by `listThreatIncidents`.
 * Pass `undefined` to restore the production default.
 * Must not be called from production routes or the dashboard.
 */
export function setThreatIncidentSourceForTests(source: ThreatIncidentSource | undefined): void {
  injectedSource = source;
}
