/**
 * Live raid / threat incident source for `GET /guilds/:guildId/threats/incidents`.
 *
 * THIS FILE IS THE ADAPTER — the single swap point for Claude's raid-mode API.
 *
 * Production `listThreatIncidents` returns an empty list until that API lands.
 * Do not put fixture or mock incidents in this function: every real server
 * would show them as if a raid were in progress. When raid mode is ready,
 * replace the body of `listThreatIncidents` with a call to it (same return
 * type). Do not read automod Redis raid-alert keys from here — those are
 * owned by the automod plugin and are not the contract.
 *
 * Tests inject a fixture source via `setThreatIncidentSourceForTests`. That
 * setter is test-only and is not used on any production path. There is no
 * env flag.
 *
 * No Redis. No Prisma. No schema change.
 */
import type { ThreatIncidentDto } from '@pavisie/types';

/** A source of threat incidents for a guild. The raid-mode API will satisfy this. */
export type ThreatIncidentSource = (guildId: string) => Promise<ThreatIncidentDto[]>;

let injectedSource: ThreatIncidentSource | undefined;

/**
 * Returns the current threat incidents for `guildId`.
 *
 * The production default is an empty array. Incidents appear here only
 * after Claude's raid-mode API is wired in, or when a test injects a source.
 */
export async function listThreatIncidents(guildId: string): Promise<ThreatIncidentDto[]> {
  if (injectedSource) return injectedSource(guildId);
  return [];
}

/**
 * Test-only. Replaces the incident source used by `listThreatIncidents`.
 * Pass `undefined` to restore the production default (an empty list).
 * Must not be called from production routes or the dashboard.
 */
export function setThreatIncidentSourceForTests(source: ThreatIncidentSource | undefined): void {
  injectedSource = source;
}
