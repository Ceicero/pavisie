// Maps Prisma `Ticket`/`TicketPanel`/`TicketParticipant` rows to `@pavisie/types/tickets` DTOs. Kept separate
// from the shared `apps/api/src/lib/dto.ts` (not owned by this task) which already exports the narrower root
// `TicketDto` used elsewhere.
import type { Ticket, TicketPanel, TicketParticipant } from '@pavisie/database';
import type {
  TicketDetailDto,
  TicketIntakeFieldDto,
  TicketPanelDto,
  TicketParticipantDto,
  TicketQueueItemDto,
} from '@pavisie/types/tickets';
import { isSlaBreached } from './sla';

function intakeFormOf(value: unknown): TicketIntakeFieldDto[] | null {
  if (!Array.isArray(value)) return null;
  return value as TicketIntakeFieldDto[];
}

export function toTicketPanelDto(row: TicketPanel): TicketPanelDto {
  return {
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    title: row.title,
    description: row.description,
    buttonLabel: row.buttonLabel,
    categoryId: row.categoryId,
    supportRoleIds: row.supportRoleIds,
    mode: row.mode,
    intakeForm: intakeFormOf(row.intakeForm),
    slaMinutes: row.slaMinutes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

export function toTicketQueueItemDto(row: Ticket): TicketQueueItemDto {
  return {
    id: row.id,
    guildId: row.guildId,
    number: row.number,
    openerId: row.openerId,
    channelId: row.channelId,
    threadId: row.threadId,
    mode: row.mode,
    status: row.status,
    subject: row.subject,
    assigneeId: row.assigneeId,
    tags: row.tags,
    slaDueAt: row.slaDueAt ? row.slaDueAt.toISOString() : null,
    slaBreached: isSlaBreached({ slaDueAt: row.slaDueAt, firstResponseAt: row.firstResponseAt }),
    firstResponseAt: row.firstResponseAt ? row.firstResponseAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
}

export function toTicketParticipantDto(row: TicketParticipant): TicketParticipantDto {
  return { id: row.id, userId: row.userId, addedBy: row.addedBy, createdAt: row.createdAt.toISOString() };
}

export function toTicketDetailDto(
  row: Ticket & { participants?: TicketParticipant[] },
  hasTranscript: boolean,
): TicketDetailDto {
  return {
    ...toTicketQueueItemDto(row),
    closedBy: row.closedBy,
    closeReason: row.closeReason,
    panelId: row.panelId,
    intake: (row.intake as Record<string, string> | null) ?? null,
    participants: (row.participants ?? []).map(toTicketParticipantDto),
    hasTranscript,
  };
}
