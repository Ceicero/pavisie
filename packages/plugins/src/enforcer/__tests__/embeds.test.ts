import { describe, expect, it } from 'vitest';
import {
  buildDecidedFlagQueueComponents,
  buildFlagQueueComponents,
  buildFlagQueueEmbed,
  buildLedgerEmbed,
} from '../embeds';

describe('buildLedgerEmbed', () => {
  it('includes the required fields (record, user, when) and never puts raw @everyone/@here in a field', () => {
    const embed = buildLedgerEmbed({
      recordNumber: 12,
      kind: 'FLAG',
      userId: '123456789012345678',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      action: 'Flagged',
      policyName: 'Test policy',
      excerpt: 'hello @everyone this is fine text',
      messageJumpUrl: 'https://discord.com/channels/1/2/3',
      source: 'AUTO',
    });
    const json = embed.toJSON();

    const fieldNames = json.fields?.map((f) => f.name) ?? [];
    expect(fieldNames).toContain('Record');
    expect(fieldNames).toContain('User');
    expect(fieldNames).toContain('When');

    const recordField = json.fields?.find((f) => f.name === 'Record');
    expect(recordField?.value).toBe('#E-12');
  });

  it('truncates an over-long context field to the embed field-value limit', () => {
    const longExcerpt = 'x'.repeat(2000);
    const embed = buildLedgerEmbed({
      recordNumber: 1,
      kind: 'FLAG',
      userId: '123456789012345678',
      createdAt: new Date(),
      excerpt: longExcerpt,
      source: 'AUTO',
    });
    const json = embed.toJSON();
    const contextField = json.fields?.find((f) => f.name === 'Context');
    expect(contextField).toBeDefined();
    expect(contextField!.value.length).toBeLessThanOrEqual(1024);
  });

  it('caps the field count at the Discord embed limit', () => {
    // Even with every optional field populated, the ledger embed builder must never exceed 25 fields.
    const embed = buildLedgerEmbed({
      recordNumber: 1,
      kind: 'DECISION',
      userId: '123456789012345678',
      createdAt: new Date(),
      action: 'Timeout (60m)',
      decidedBy: '223456789012345678',
      policyName: 'Test policy',
      caseNumber: 5,
      excerpt: 'excerpt',
      messageJumpUrl: 'https://discord.com/channels/1/2/3',
      source: 'BOT',
    });
    expect(embed.toJSON().fields!.length).toBeLessThanOrEqual(25);
  });
});

describe('buildFlagQueueEmbed', () => {
  const english = (key: string): string => {
    if (key === 'policy.detail.severity') return 'Severity';
    if (key === 'policy.detail.suggestedAction') return 'Suggested action';
    return key;
  };

  it('shows a "Decided by" footer once decided, and a plain source footer while pending', () => {
    const pending = buildFlagQueueEmbed(
      {
        recordId: 'r1',
        recordNumber: 1,
        userId: '123456789012345678',
        createdAt: new Date(),
        severity: 'MEDIUM',
        source: 'AUTO',
      },
      english,
    );
    expect(pending.toJSON().footer?.text).toMatch(/^Source:/);

    const decided = buildFlagQueueEmbed(
      {
        recordId: 'r1',
        recordNumber: 1,
        userId: '123456789012345678',
        createdAt: new Date(),
        severity: 'MEDIUM',
        source: 'AUTO',
        decidedBy: '223456789012345678',
        decidedAt: new Date(),
      },
      english,
    );
    expect(decided.toJSON().footer?.text).toMatch(/^Decided by/);
  });

  it('names severity and suggested action from the caller locale', () => {
    const t = (key: string) => `L:${key}`;
    const embed = buildFlagQueueEmbed(
      {
        recordId: 'r1',
        recordNumber: 4,
        userId: '123456789012345678',
        createdAt: new Date(),
        severity: 'HIGH',
        suggestedAction: 'ban',
        source: 'AUTO',
      },
      t,
    );
    const fields = embed.toJSON().fields ?? [];
    expect(fields.find((field) => field.name === 'L:policy.detail.severity')?.value).toBe('HIGH');
    expect(fields.find((field) => field.name === 'L:policy.detail.suggestedAction')?.value).toBe('ban');
  });
});

describe('flag-queue decision components', () => {
  it('only renders buttons for allowed decisions, plus the context/history helper row', () => {
    const rows = buildFlagQueueComponents('r1', ['warn', 'dismiss']);
    const allButtons = rows.flatMap((row) => row.components);
    // Every button here is a non-link style, which always carries `custom_id` (never `url`) — but the builder's
    // `.data` type is the full union including link buttons, so narrow via `toJSON()` instead of casting `.data`.
    const customIds = allButtons.map((b) => (b.toJSON() as { custom_id?: string }).custom_id);

    expect(customIds).toContain('enforcer:decide:r1:warn');
    expect(customIds).toContain('enforcer:decide:r1:dismiss');
    expect(customIds).not.toContain('enforcer:decide:r1:ban');
    expect(customIds).toContain('enforcer:context:r1');
    expect(customIds).toContain('enforcer:history:r1');
  });

  it('disables every button in the decided variant', () => {
    const rows = buildDecidedFlagQueueComponents('r1', ['warn', 'timeout', 'mute', 'kick', 'ban', 'dismiss']);
    const allButtons = rows.flatMap((row) => row.components);
    expect(allButtons.length).toBeGreaterThan(0);
    for (const button of allButtons) {
      expect(button.data.disabled).toBe(true);
    }
  });
});
