import type { AuditLog, PrismaClient } from '@pavisie/database';
import { writeAudit as writeAuditRow } from '@pavisie/database';

export interface DashboardAuditInput {
  guildId: string;
  actorId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** Thin wrapper over `@pavisie/database`'s `writeAudit`, fixing `source: 'dashboard'` and `actorType: 'user'` — every dashboard write goes through this (ARCHITECTURE.md §10). */
export async function writeDashboardAudit(
  prisma: PrismaClient,
  entry: DashboardAuditInput,
): Promise<AuditLog> {
  return writeAuditRow(prisma, {
    ...entry,
    actorType: 'user',
    source: 'dashboard',
  });
}
