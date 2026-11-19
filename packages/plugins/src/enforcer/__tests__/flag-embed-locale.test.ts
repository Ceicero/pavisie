import { ChannelType, type Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import type { EnforcerConfig } from '../manifest';
import { flagRecord } from '../service';

function config(overrides: Partial<EnforcerConfig> = {}): EnforcerConfig {
  return {
    ledgerChannelId: null,
    ledgerVisibility: 'staff',
    flagChannelId: 'flags',
    muteRoleId: null,
    captureContext: false,
    contextBefore: 5,
    contextAfter: 3,
    excerptMaxChars: 300,
    autoFlagEnabled: false,
    exemptStaff: true,
    aiAssist: false,
    dmOnAction: false,
    defaultTimeoutMinutes: 60,
    defaultMuteMinutes: null,
    requireReasonOn: ['kick', 'ban'],
    allowedDecisions: ['warn', 'dismiss'],
    banDeleteMessageSeconds: 0,
    ...overrides,
  };
}

function fakePrisma(): PrismaClient {
  let seq = 0;
  return {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ enforcerRecord: { aggregate: async () => ({ _max: { recordNumber: seq } }) } }),
    enforcerRecord: {
      create: async (args: { data: Record<string, unknown> }) => {
        seq += 1;
        return { id: `rec-${seq}`, recordNumber: seq, ...args.data };
      },
      update: async () => ({}),
    },
  } as unknown as PrismaClient;
}

describe('flag-queue embed locale', () => {
  it('renders severity and suggested action in the guild locale', async () => {
    const sent: { embeds: { toJSON(): { fields?: { name: string; value: string }[] } }[] }[] = [];
    const calls: { key: string; locale?: string }[] = [];
    const channel = {
      type: ChannelType.GuildText,
      send: async (payload: (typeof sent)[number]) => {
        sent.push(payload);
        return { id: 'flag-msg-1' };
      },
    };
    const guild = {
      id: 'g1',
      channels: { fetch: async (id: string) => (id === 'flags' ? channel : null) },
    };
    const client = { guilds: { fetch: async () => guild } } as unknown as Client<true>;

    const { ctx, services } = createTestContext({
      config: config(),
      overrides: {
        prisma: fakePrisma(),
        client,
        t: (key: string, _vars?: Record<string, string | number>, locale?: string) => {
          calls.push({ key, locale });
          return `L:${key}`;
        },
      },
    });
    services.register('host', {
      getGuildConfig: async () => ({ locale: 'pt-BR' }),
    } as never);

    await flagRecord(ctx, {
      guildId: 'g1',
      userId: 'user-1',
      severity: 'HIGH',
      suggestedAction: 'ban',
      source: 'MANUAL',
    });

    const names = sent[0]?.embeds[0]?.toJSON().fields?.map((field) => field.name) ?? [];
    expect(names).toContain('L:policy.detail.severity');
    expect(names).toContain('L:policy.detail.suggestedAction');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.locale === 'pt')).toBe(true);
  });
});
