// Maps Prisma rows to `@pavisie/types` DTOs, mirroring the convention in `apps/api/src/lib/enforcer/dto.ts`.
import type { DeveloperReport } from '@pavisie/database';
import type { DeveloperReportDto } from '@pavisie/types';

export function toDeveloperReportDto(row: DeveloperReport): DeveloperReportDto {
  return {
    id: row.id,
    guildId: row.guildId,
    guildName: row.guildName,
    senderId: row.senderId,
    senderTag: row.senderTag,
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    botVersion: row.botVersion,
    status: row.status,
    notes: row.notes,
    handledAt: row.handledAt ? row.handledAt.toISOString() : null,
    handledBy: row.handledBy,
    createdAt: row.createdAt.toISOString(),
  };
}
