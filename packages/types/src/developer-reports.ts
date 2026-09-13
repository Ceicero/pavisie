/**
 * DTOs for the owner-only developer-reports ops API (guild admin → bot developer support channel).
 * The `admin` plugin's `/pavisie report` command is the only writer; `apps/api`'s `/owner/developer-reports`
 * routes (gated on bot-owner identity, not `requireGuildAccess` — this is intentionally cross-guild data) are
 * the only reader/mutator, for the future ops-console UI.
 */

export type DeveloperReportKind = 'BUG' | 'FEEDBACK' | 'QUESTION';
export type DeveloperReportStatus = 'OPEN' | 'HANDLED';

export interface DeveloperReportDto {
  id: string;
  guildId: string;
  guildName: string;
  senderId: string;
  senderTag: string;
  kind: DeveloperReportKind;
  subject: string;
  body: string;
  botVersion: string;
  status: DeveloperReportStatus;
  /** Internal-only triage notes for the bot developer; never shown to the reporting guild. */
  notes: string | null;
  handledAt: string | null;
  handledBy: string | null;
  createdAt: string;
}

/** `PATCH /owner/developer-reports/:id` body — every field optional so status and notes can be saved independently. */
export interface DeveloperReportPatchRequest {
  status?: DeveloperReportStatus;
  notes?: string;
}
