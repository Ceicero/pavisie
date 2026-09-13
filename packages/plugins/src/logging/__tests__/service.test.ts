import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../../sdk/testing';
import { LoggingServiceImpl } from '../service';
import type { LoggingConfig } from '../manifest';

const GUILD_ID = '999999999999999999';

function baseConfig(overrides: Partial<LoggingConfig> = {}): LoggingConfig {
  return {
    channels: {}, // no channel mapped — log() never reaches the batcher/Discord client in these tests
    enabledKinds: ['message.delete', 'member.join', 'moderation.action'],
    storeEvents: true,
    retentionDays: 90,
    redactionPatterns: [],
    captureContent: false,
    ...overrides,
  };
}

describe('LoggingServiceImpl.log — kind gating', () => {
  it('does nothing (no LogEvent write) when the kind is not in enabledKinds', async () => {
    const created = vi.fn();
    const { ctx } = createTestContext({
      config: baseConfig({ enabledKinds: [] }),
      prismaOverrides: { logEvent: { create: created } },
    });
    const service = new LoggingServiceImpl(ctx);

    await service.log(GUILD_ID, 'member.join', { targetId: '1' });

    expect(created).not.toHaveBeenCalled();
  });
});

describe('LoggingServiceImpl.log — storage', () => {
  it('stores a LogEvent row when storeEvents is true', async () => {
    const created = vi.fn().mockResolvedValue({});
    const { ctx } = createTestContext({
      config: baseConfig({ storeEvents: true }),
      prismaOverrides: { logEvent: { create: created } },
    });
    const service = new LoggingServiceImpl(ctx);

    await service.log(GUILD_ID, 'member.join', { targetId: '42', description: 'joined' });

    expect(created).toHaveBeenCalledTimes(1);
    const [args] = created.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(args.data.guildId).toBe(GUILD_ID);
    expect(args.data.kind).toBe('member.join');
    expect(args.data.targetId).toBe('42');
  });

  it('does not store a LogEvent row when storeEvents is false', async () => {
    const created = vi.fn();
    const { ctx } = createTestContext({
      config: baseConfig({ storeEvents: false }),
      prismaOverrides: { logEvent: { create: created } },
    });
    const service = new LoggingServiceImpl(ctx);

    await service.log(GUILD_ID, 'member.join', { targetId: '42' });

    expect(created).not.toHaveBeenCalled();
  });

  it('redacts a stored payload (email in the description)', async () => {
    const created = vi.fn().mockResolvedValue({});
    const { ctx } = createTestContext({
      config: baseConfig(),
      prismaOverrides: { logEvent: { create: created } },
    });
    const service = new LoggingServiceImpl(ctx);

    await service.log(GUILD_ID, 'message.delete', { description: 'contact leaker@example.com about this' });

    const [args] = created.mock.calls[0] as [{ data: { payload: { description: string } } }];
    expect(args.data.payload.description).toBe('contact [redacted:email] about this');
  });

  it('only includes content fields when both the guild-wide and plugin-level content flags are on', async () => {
    const created = vi.fn().mockResolvedValue({});
    const { ctx, services } = createTestContext({
      config: baseConfig({ captureContent: true }),
      prismaOverrides: { logEvent: { create: created } },
    });
    services.register('host', {
      getGuildConfig: async () => ({ logMessageContent: false }) as never,
    } as never);
    const service = new LoggingServiceImpl(ctx);

    await service.log(GUILD_ID, 'message.delete', { contentBefore: 'the original text' });

    const [args] = created.mock.calls[0] as [{ data: { payload: Record<string, unknown> } }];
    expect(args.data.payload.contentBefore).toBeUndefined();
  });

  it('includes content when both flags are on', async () => {
    const created = vi.fn().mockResolvedValue({});
    const { ctx, services } = createTestContext({
      config: baseConfig({ captureContent: true }),
      prismaOverrides: { logEvent: { create: created } },
    });
    services.register('host', {
      getGuildConfig: async () => ({ logMessageContent: true }) as never,
    } as never);
    const service = new LoggingServiceImpl(ctx);

    await service.log(GUILD_ID, 'message.delete', { contentBefore: 'the original text' });

    const [args] = created.mock.calls[0] as [{ data: { payload: Record<string, unknown> } }];
    expect(args.data.payload.contentBefore).toBe('the original text');
  });

  it('strips attachments when message-content logging is off (guild-wide setting)', async () => {
    const created = vi.fn().mockResolvedValue({});
    const { ctx, services } = createTestContext({
      config: baseConfig({ captureContent: true }),
      prismaOverrides: { logEvent: { create: created } },
    });
    services.register('host', {
      getGuildConfig: async () => ({ logMessageContent: false }) as never,
    } as never);
    const service = new LoggingServiceImpl(ctx);

    await service.log(GUILD_ID, 'message.delete', {
      attachments: ['https://cdn.discordapp.com/file1.png', 'https://cdn.discordapp.com/file2.jpg'],
    });

    const [args] = created.mock.calls[0] as [{ data: { payload: Record<string, unknown> } }];
    expect(args.data.payload.attachments).toBeUndefined();
  });

  it('includes attachments when both content flags are on', async () => {
    const created = vi.fn().mockResolvedValue({});
    const { ctx, services } = createTestContext({
      config: baseConfig({ captureContent: true }),
      prismaOverrides: { logEvent: { create: created } },
    });
    services.register('host', {
      getGuildConfig: async () => ({ logMessageContent: true }) as never,
    } as never);
    const service = new LoggingServiceImpl(ctx);

    const urls = ['https://cdn.discordapp.com/file1.png', 'https://cdn.discordapp.com/file2.jpg'];
    await service.log(GUILD_ID, 'message.delete', { attachments: urls });

    const [args] = created.mock.calls[0] as [{ data: { payload: Record<string, unknown> } }];
    expect(args.data.payload.attachments).toEqual(urls);
  });

  it('strips attachments when plugin-level captureContent flag is off', async () => {
    const created = vi.fn().mockResolvedValue({});
    const { ctx, services } = createTestContext({
      config: baseConfig({ captureContent: false }),
      prismaOverrides: { logEvent: { create: created } },
    });
    services.register('host', {
      getGuildConfig: async () => ({ logMessageContent: true }) as never,
    } as never);
    const service = new LoggingServiceImpl(ctx);

    await service.log(GUILD_ID, 'message.delete', {
      attachments: ['https://cdn.discordapp.com/file1.png'],
    });

    const [args] = created.mock.calls[0] as [{ data: { payload: Record<string, unknown> } }];
    expect(args.data.payload.attachments).toBeUndefined();
  });
});

describe('LoggingServiceImpl.purgeRetention', () => {
  it('uses min(config.retentionDays, DataRetentionPolicy.logEventDays) as the effective cutoff', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const { ctx } = createTestContext({
      config: baseConfig({ retentionDays: 90 }),
      prismaOverrides: {
        dataRetentionPolicy: { findUnique: async () => ({ logEventDays: 30 }) },
        logEvent: { deleteMany },
      },
    });
    const service = new LoggingServiceImpl(ctx);

    const before = Date.now();
    const count = await service.purgeRetention(GUILD_ID);
    expect(count).toBe(3);

    const [args] = deleteMany.mock.calls[0] as [{ where: { guildId: string; createdAt: { lt: Date } } }];
    expect(args.where.guildId).toBe(GUILD_ID);
    const cutoffMs = args.where.createdAt.lt.getTime();
    const expectedMs = before - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(5000); // small tolerance for test execution time
  });

  it('falls back to the platform default retention (90 days) when no DataRetentionPolicy row exists', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const { ctx } = createTestContext({
      config: baseConfig({ retentionDays: 365 }),
      prismaOverrides: {
        dataRetentionPolicy: { findUnique: async () => null },
        logEvent: { deleteMany },
      },
    });
    const service = new LoggingServiceImpl(ctx);

    await service.purgeRetention(GUILD_ID);

    const [args] = deleteMany.mock.calls[0] as [{ where: { createdAt: { lt: Date } } }];
    const cutoffMs = args.where.createdAt.lt.getTime();
    const expectedMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(5000);
  });

  it("uses the plugin's own retentionDays when it is shorter than the platform policy", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const { ctx } = createTestContext({
      config: baseConfig({ retentionDays: 7 }),
      prismaOverrides: {
        dataRetentionPolicy: { findUnique: async () => ({ logEventDays: 365 }) },
        logEvent: { deleteMany },
      },
    });
    const service = new LoggingServiceImpl(ctx);

    await service.purgeRetention(GUILD_ID);

    const [args] = deleteMany.mock.calls[0] as [{ where: { createdAt: { lt: Date } } }];
    const cutoffMs = args.where.createdAt.lt.getTime();
    const expectedMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(5000);
  });
});
