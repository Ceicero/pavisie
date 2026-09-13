// Formula-injection-safe CSV encoding, mirroring `apps/api/src/lib/csv.ts` (SPEC.md's CSV-export requirement).
// Duplicated rather than imported across the app/package boundary — packages must not depend on apps.
import type { EnforcerRecord } from '@pavisie/database';

const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@']);

function escapeCsvCell(value: unknown): string {
  let str = value === null || value === undefined ? '' : String(value);
  if (str.length > 0 && FORMULA_TRIGGER_CHARS.has(str[0])) str = `'${str}`;
  if (/[",\r\n]/.test(str)) str = `"${str.replace(/"/g, '""')}"`;
  return str;
}

const COLUMNS = [
  'recordNumber',
  'kind',
  'status',
  'userId',
  'channelId',
  'messageId',
  'policyName',
  'matcherSummary',
  'source',
  'decision',
  'decidedBy',
  'decisionReason',
  'durationMs',
  'caseId',
  'excerpt',
  'createdAt',
] as const;

/** Serializes ledger records to CSV text (CRLF line endings), for `/enforcer export` and the dashboard's export endpoint. */
export function recordsToCsv(rows: EnforcerRecord[]): string {
  const lines = [COLUMNS.join(',')];
  for (const row of rows) {
    const values: Record<(typeof COLUMNS)[number], unknown> = {
      recordNumber: row.recordNumber,
      kind: row.kind,
      status: row.status ?? '',
      userId: row.userId,
      channelId: row.channelId ?? '',
      messageId: row.messageId ?? '',
      policyName: row.policyName ?? '',
      matcherSummary: row.matcherSummary ?? '',
      source: row.source,
      decision: row.decision ?? '',
      decidedBy: row.decidedBy ?? '',
      decisionReason: row.decisionReason ?? '',
      durationMs: row.durationMs ?? '',
      caseId: row.caseId ?? '',
      excerpt: row.excerpt ?? '',
      createdAt: row.createdAt.toISOString(),
    };
    lines.push(COLUMNS.map((col) => escapeCsvCell(values[col])).join(','));
  }
  return lines.join('\r\n');
}
