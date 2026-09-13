// DTOs for the `tickets` plugin (SPEC.md §E; ARCHITECTURE.md §7.1). Imported by the API and dashboard via the
// subpath `@pavisie/types/tickets` — `packages/types/src/index.ts` is not touched by this plugin (per its
// ownership rules), so these types are NOT re-exported from the package root barrel.

/** One question in a panel/settings intake form (config-defined, up to 5 per ARCHITECTURE.md §19-style limits). */
export interface TicketIntakeFieldDto {
  label: string;
  style: 'short' | 'paragraph';
  required: boolean;
}

/** `tickets` plugin per-guild config (mirrors `TicketsConfig` in `packages/plugins/src/tickets/manifest.ts`). */
export interface TicketsSettingsDto {
  supportRoleIds: string[];
  categoryId: string | null;
  mode: 'channel' | 'thread';
  transcriptChannelId: string | null;
  transcriptRetentionDays: number;
  dmTranscript: boolean;
  slaMinutes: number | null;
  maxOpenPerUser: number;
  reopenWindowHours: number;
  deleteAfterCloseSeconds: number;
  keepClosedChannels: boolean;
  intakeForm: TicketIntakeFieldDto[];
  alertChannelId: string | null;
}

export interface TicketPanelDto {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  title: string;
  description: string;
  buttonLabel: string;
  categoryId: string | null;
  supportRoleIds: string[];
  mode: 'CHANNEL' | 'THREAD';
  intakeForm: TicketIntakeFieldDto[] | null;
  slaMinutes: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface TicketParticipantDto {
  id: string;
  userId: string;
  addedBy: string;
  createdAt: string;
}

/** Row shape for the dashboard queue table — a `TicketDto` (see `@pavisie/types` root) plus computed SLA state. */
export interface TicketQueueItemDto {
  id: string;
  guildId: string;
  number: number;
  openerId: string;
  channelId: string | null;
  threadId: string | null;
  mode: 'CHANNEL' | 'THREAD';
  status: 'OPEN' | 'CLOSED' | 'ARCHIVED';
  subject: string | null;
  assigneeId: string | null;
  tags: string[];
  slaDueAt: string | null;
  slaBreached: boolean;
  firstResponseAt: string | null;
  createdAt: string;
  closedAt: string | null;
}

/** Full ticket detail — participants and transcript availability included (dashboard detail drawer). */
export interface TicketDetailDto extends TicketQueueItemDto {
  closedBy: string | null;
  closeReason: string | null;
  panelId: string | null;
  intake: Record<string, string> | null;
  participants: TicketParticipantDto[];
  hasTranscript: boolean;
}
