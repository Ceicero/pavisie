import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { buildPaginated, paginate } from '@pavisie/core';
import type { ModerationAuditEntryDto, Paginated, ThreatIncidentDto } from '@pavisie/types';
import { toAuditLogEntryDto } from '../lib/dto';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema, paginationQuerySchema } from '../lib/schemas';
import { listThreatIncidents } from '../lib/threat-incidents';

const MODERATION_ACTION_PREFIX = 'moderation.';

const auditQuerySchema = paginationQuerySchema.extend({
  action: z.string().optional(),
  actorId: z.string().optional(),
});

/**
 * Pulls optional case fields off an audit row's `after` payload.
 * `moderation.case.create` writes `{ type, targetId, caseNumber }`; other
 * moderation actions typically don't, and those fields stay unset.
 */
export function caseFieldsFromAfter(after: unknown): { caseNumber?: number; caseType?: string } {
  if (after === null || after === undefined || typeof after !== 'object' || Array.isArray(after)) {
    return {};
  }
  const record = after as Record<string, unknown>;
  const rawNumber = record.caseNumber;
  const caseNumber =
    typeof rawNumber === 'number' && Number.isInteger(rawNumber) && rawNumber > 0 ? rawNumber : undefined;
  const rawType = record.type;
  const caseType = typeof rawType === 'string' && rawType.length > 0 ? rawType : undefined;
  return {
    ...(caseNumber !== undefined ? { caseNumber } : {}),
    ...(caseType !== undefined ? { caseType } : {}),
  };
}

export function toModerationAuditEntryDto(row: Parameters<typeof toAuditLogEntryDto>[0]): ModerationAuditEntryDto {
  const base = toAuditLogEntryDto(row);
  return { ...base, ...caseFieldsFromAfter(base.after) };
}

/** True when `action` is in the Threat overview allow-list: every `moderation.*` action. */
export function isModerationAuditAction(action: string): boolean {
  return action.startsWith(MODERATION_ACTION_PREFIX);
}

/**
 * `/guilds/:guildId/threats` — Threat overview: the moderation audit trail
 * (live, read-only) and live raid/threat incidents (stub until raid-mode API).
 */
export default async function threatsRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/threats/audit',
    {
      schema: { params: guildIdParamSchema, querystring: auditQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<ModerationAuditEntryDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit, action, actorId } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });

      // A requested `action` that is not a moderation.* action can never match
      // the allow-list; return an empty page rather than leaking other audit rows.
      if (action && !isModerationAuditAction(action)) {
        return buildPaginated([], limit, offset);
      }

      const rows = await app.prisma.auditLog.findMany({
        where: {
          guildId,
          action: action ? action : { startsWith: MODERATION_ACTION_PREFIX },
          ...(actorId ? { actorId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
      });

      return buildPaginated(rows.map(toModerationAuditEntryDto), limit, offset);
    },
  );

  app.get(
    '/:guildId/threats/incidents',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<ThreatIncidentDto[]> => {
      return listThreatIncidents(request.guildId!);
    },
  );
}
