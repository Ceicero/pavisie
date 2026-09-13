import type { EnforcerRecord } from '@pavisie/database';
import { describe, expect, it } from 'vitest';
import { recordsToCsv } from '../csv';

function row(overrides: Partial<EnforcerRecord> = {}): EnforcerRecord {
  return {
    id: 'r1',
    guildId: 'g1',
    recordNumber: 1,
    kind: 'FLAG',
    status: 'PENDING',
    userId: 'u1',
    channelId: null,
    messageId: null,
    messageJumpUrl: null,
    policyId: null,
    policyName: null,
    matcherSummary: null,
    riskScore: null,
    aiExplanation: null,
    excerpt: null,
    contextSnapshot: null,
    source: 'AUTO',
    flaggedBy: null,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    durationMs: null,
    caseId: null,
    parentRecordId: null,
    ledgerMessageId: null,
    flagMessageId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as EnforcerRecord;
}

describe('recordsToCsv', () => {
  it('writes a header row followed by one row per record', () => {
    const csv = recordsToCsv([row(), row({ id: 'r2', recordNumber: 2 })]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      'recordNumber,kind,status,userId,channelId,messageId,policyName,matcherSummary,source,decision,decidedBy,decisionReason,durationMs,caseId,excerpt,createdAt',
    );
  });

  it('defuses a formula-injection payload in an excerpt', () => {
    const csv = recordsToCsv([row({ excerpt: '=cmd|"/c calc"!A1' })]);
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toContain("'=cmd");
  });

  it('quotes a value containing a comma or newline', () => {
    const csv = recordsToCsv([row({ decisionReason: 'reason, with a comma\nand a newline' })]);
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toContain('"reason, with a comma\nand a newline"');
  });

  it('renders an empty string for every null field', () => {
    const csv = recordsToCsv([row()]);
    const dataLine = csv.split('\r\n')[1];
    // recordNumber, kind, status, userId, source are non-null; every other column is null in the fixture.
    expect(dataLine.split(',')).toEqual([
      '1',
      'FLAG',
      'PENDING',
      'u1',
      '',
      '',
      '',
      '',
      'AUTO',
      '',
      '',
      '',
      '',
      '',
      '',
      '2026-01-01T00:00:00.000Z',
    ]);
  });
});
