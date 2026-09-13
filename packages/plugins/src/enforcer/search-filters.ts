// Pure ledger-search where-clause builder, shared by the bot's `/enforcer search` and the dashboard's
// `GET /guilds/:guildId/enforcer/records` (framework-free — no discord.js — so it's safe to import from apps/api
// via the `@pavisie/plugins/enforcer/search-filters` subpath).
import { parseDuration } from '@pavisie/core';
import type { EnforcerDecision, EnforcerRecordKind, EnforcerFlagStatus, Prisma } from '@pavisie/database';

export interface RecordSearchFilters {
  guildId: string;
  userId?: string | null;
  kind?: string | null;
  decision?: string | null;
  status?: string | null;
  policyId?: string | null;
  /** A duration string like `'7d'`/`'24h'`, or an already-resolved ISO/`Date` lower bound. */
  since?: string | Date | null;
}

/** Builds an `EnforcerRecord` `where` clause from user-supplied filters, parsing `since` as either a duration (`'7d'`) or a date. */
export function buildRecordSearchWhere(filters: RecordSearchFilters): Prisma.EnforcerRecordWhereInput {
  const where: Prisma.EnforcerRecordWhereInput = { guildId: filters.guildId };

  if (filters.userId) where.userId = filters.userId;
  if (filters.kind) where.kind = filters.kind as EnforcerRecordKind;
  if (filters.decision) where.decision = filters.decision as EnforcerDecision;
  if (filters.status) where.status = filters.status as EnforcerFlagStatus;
  if (filters.policyId) where.policyId = filters.policyId;

  if (filters.since instanceof Date) {
    where.createdAt = { gte: filters.since };
  } else if (typeof filters.since === 'string' && filters.since.length > 0) {
    const parsedDuration = parseDuration(filters.since);
    if (parsedDuration !== null) {
      where.createdAt = { gte: new Date(Date.now() - parsedDuration) };
    } else {
      const parsedDate = new Date(filters.since);
      if (!Number.isNaN(parsedDate.getTime())) where.createdAt = { gte: parsedDate };
    }
  }

  return where;
}
