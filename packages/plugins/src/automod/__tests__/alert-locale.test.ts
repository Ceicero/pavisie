import type { Guild, Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { AutomodRule } from '@pavisie/database';
import { createTestContext } from '../../sdk/testing';
import type { AutomodConfig } from '../manifest';
import { handleMessage } from '../service';

// Staff alerts are posted into a channel, so they follow the guild's configured locale rather than
// whoever happened to send the matching message. These tests pin the field names and review buttons
// that already have locale keys.

interface SentPayload {
  embeds: { toJSON(): { fields?: { name: string; value: string }[] } }[];
  components?: { components: { toJSON(): { label?: string } }[] }[];
}

const CONFIG: AutomodConfig = {
  dryRun: false,
  alertChannelId: 'alerts',
  quarantineRoleId: null,
  exemptStaff: true,
  defaultTimeoutMs: 600_000,
  raidLockdown: 'none',
  raidLockdownMinutes: 15,
};

function wordRule(): AutomodRule {
  return {
    id: 'alert-locale-rule',
    guildId: 'alert-locale-guild',
    name: 'Bananas',
    type: 'WORD_FILTER',
    enabled: true,
    dryRun: false,
    config: { type: 'WORD_FILTER', words: ['bananapants'], wholeWord: true, caseSensitive: false },
    actions: [{ type: 'alert_staff' }],
    exemptRoleIds: [],
    exemptChannelIds: [],
    exemptUserIds: [],
    trustedDomains: [],
    cooldownSeconds: 0,
    priority: 0,
    deletedAt: null,
    createdBy: 'mod',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as AutomodRule;
}

describe('automod alert embed locale', () => {
  it('names the alert fields and review buttons from the guild locale', async () => {
    const guildId = 'alert-locale-guild';
    const sent: SentPayload[] = [];
    const calls: { key: string; locale?: string }[] = [];

    const alertChannel = {
      id: 'alerts',
      type: 0,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      send: async (payload: SentPayload) => {
        sent.push(payload);
        return { id: 'alert-1' };
      },
    };
    const guild = {
      id: guildId,
      ownerId: 'owner',
      members: {
        me: { id: 'bot' },
        cache: new Map(),
        fetch: async () => {
          throw new Error('member not cached');
        },
      },
      channels: { fetch: async () => alertChannel },
    } as unknown as Guild;

    const { ctx, services } = createTestContext({
      config: CONFIG,
      intentsEnabled: { messageContent: true },
      prismaOverrides: {
        automodRule: { findMany: async () => [wordRule()] },
        automodEvent: {
          create: async () => ({ id: 'event-1' }),
        },
      },
      overrides: {
        client: { guilds: { cache: new Map([[guildId, guild]]) }, user: { id: 'bot' } } as never,
        t: (key: string, _vars?: Record<string, string | number>, locale?: string) => {
          calls.push({ key, locale });
          return `L:${key}`;
        },
      },
    });
    services.register('host', {
      getGuildConfig: async () => ({ locale: 'es-ES', logMessageContent: true }),
    } as never);

    await handleMessage(ctx, {
      id: 'alert-locale-msg',
      guildId,
      channelId: 'general',
      author: { id: 'member-1', bot: false, system: false },
      webhookId: null,
      guild,
      member: null,
      channel: { nsfw: false },
      content: 'you are a bananapants',
      mentions: { users: new Map(), roles: new Map(), everyone: false },
      attachments: new Map(),
      createdAt: new Date(),
      delete: async () => undefined,
    } as unknown as Message);

    expect(sent).toHaveLength(1);
    const fields = sent[0]?.embeds[0]?.toJSON().fields ?? [];
    const name = (label: string) => fields.find((field) => field.name === label);
    expect(name('L:automod.review.label.user')?.value).toBe('<@member-1>');
    expect(name('L:automod.review.label.channel')?.value).toBe('<#general>');
    expect(name('L:automod.review.label.actions')?.value).toContain('alert_staff');
    expect(name('L:automod.review.label.matchedContent')?.value).toContain('bananapants');
    // No exact key for this label (`review.label.rule` is "Rule"). It stays hard-coded.
    expect(fields.some((field) => field.name === 'Rule type' && field.value === 'WORD_FILTER')).toBe(true);

    const labels = (sent[0]?.components ?? []).flatMap((row) =>
      row.components.map((button) => button.toJSON().label),
    );
    expect(labels).toEqual([
      'L:automod.review.label.confirmViolation',
      'L:automod.review.label.falsePositive',
    ]);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.locale === 'es')).toBe(true);
    expect(calls.some((call) => call.key.toLowerCase().includes('ruletype'))).toBe(false);
  });

  it('still posts the alert in English when the guild locale cannot be read', async () => {
    const guildId = 'alert-locale-fallback';
    const sent: SentPayload[] = [];
    const calls: { key: string; locale?: string }[] = [];

    const alertChannel = {
      id: 'alerts',
      type: 0,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      send: async (payload: SentPayload) => {
        sent.push(payload);
        return { id: 'alert-1' };
      },
    };
    const guild = {
      id: guildId,
      ownerId: 'owner',
      members: {
        me: { id: 'bot' },
        cache: new Map(),
        fetch: async () => {
          throw new Error('member not cached');
        },
      },
      channels: { fetch: async () => alertChannel },
    } as unknown as Guild;

    const { ctx, services } = createTestContext({
      config: CONFIG,
      intentsEnabled: { messageContent: true },
      prismaOverrides: {
        automodRule: { findMany: async () => [wordRule()] },
        automodEvent: { create: async () => ({ id: 'event-1' }) },
      },
      overrides: {
        client: { guilds: { cache: new Map([[guildId, guild]]) }, user: { id: 'bot' } } as never,
        t: (key: string, _vars?: Record<string, string | number>, locale?: string) => {
          calls.push({ key, locale });
          return `L:${key}`;
        },
      },
    });
    services.register('host', {
      getGuildConfig: async () => {
        throw new Error('config store down');
      },
    } as never);

    await handleMessage(ctx, {
      id: 'alert-locale-fallback-msg',
      guildId,
      channelId: 'general',
      author: { id: 'member-1', bot: false, system: false },
      webhookId: null,
      guild,
      member: null,
      channel: { nsfw: false },
      content: 'you are a bananapants',
      mentions: { users: new Map(), roles: new Map(), everyone: false },
      attachments: new Map(),
      createdAt: new Date(),
      delete: async () => undefined,
    } as unknown as Message);

    expect(sent).toHaveLength(1);
    const names = sent[0]?.embeds[0]?.toJSON().fields?.map((field) => field.name) ?? [];
    expect(names).toContain('L:automod.review.label.user');
    expect(calls.every((call) => call.locale === 'en')).toBe(true);
  });
});
