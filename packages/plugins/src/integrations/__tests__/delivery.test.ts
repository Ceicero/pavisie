import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// `@pavisie/core`'s `env` singleton is computed once, at that module's first import, from `process.env` — so
// `ENCRYPTION_KEY` must be set *before* anything (transitively) imports `@pavisie/core`. This file has no
// static imports of its own for that reason (matching `src/ai/__tests__/resolve-key.test.ts`'s pattern):
// everything it needs is imported dynamically inside `beforeAll`, after the env var is set.
let encryptSecret: typeof import('@pavisie/core').encryptSecret;
let createTestContext: typeof import('../../sdk/testing').createTestContext;
let attemptOutboundDelivery: typeof import('../delivery').attemptOutboundDelivery;
let OUTBOUND_AUTO_DISABLE_THRESHOLD: number;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('base64');
  ({ encryptSecret } = await import('@pavisie/core'));
  ({ createTestContext } = await import('../../sdk/testing'));
  ({ attemptOutboundDelivery } = await import('../delivery'));
  ({ OUTBOUND_AUTO_DISABLE_THRESHOLD } = await import('../signing'));
});

function makeEndpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: 'endpoint-1',
    guildId: '111111111111111111',
    direction: 'OUTBOUND' as const,
    provider: 'generic',
    name: 'My webhook',
    url: 'https://example.com/hook',
    secretEnc: encryptSecret('endpoint-secret'),
    events: ['moderation.caseCreated'],
    channelId: null,
    enabled: true,
    lastDeliveryAt: null,
    failureCount: 0,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('attemptOutboundDelivery', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rejects a private/internal URL before ever sending (SSRF)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { ctx } = createTestContext({
      prismaOverrides: {
        webhookDelivery: { create: async () => ({}) },
        webhookEndpoint: { update: async () => ({ failureCount: 1, enabled: true }) },
      },
    });
    const endpoint = makeEndpoint({ url: 'https://127.0.0.1:9999/hook' });

    const result = await attemptOutboundDelivery(
      ctx,
      endpoint as never,
      { event: 'moderation.caseCreated' },
      1,
    );

    expect(result.delivered).toBe(false);
    expect(result.error).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('delivers successfully and records a WebhookDelivery + resets failureCount on a 2xx response', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const deliveryCreates: unknown[] = [];
    const endpointUpdates: unknown[] = [];
    const { ctx } = createTestContext({
      prismaOverrides: {
        webhookDelivery: {
          create: async (args: unknown) => {
            deliveryCreates.push(args);
            return {};
          },
        },
        webhookEndpoint: {
          update: async (args: unknown) => {
            endpointUpdates.push(args);
            return { failureCount: 0, enabled: true };
          },
        },
      },
    });

    const endpoint = makeEndpoint();
    const result = await attemptOutboundDelivery(
      ctx,
      endpoint as never,
      { event: 'moderation.caseCreated' },
      1,
    );

    expect(result.delivered).toBe(true);
    expect(result.status).toBe(200);
    expect(deliveryCreates).toHaveLength(1);
    expect(endpointUpdates).toHaveLength(1);
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['X-Pavisie-Signature']).toBeTruthy();
    expect(headers['X-Pavisie-Event']).toBe('moderation.caseCreated');
  });

  it('auto-disables the endpoint once failureCount reaches the threshold', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;

    let disabled = false;
    const { ctx } = createTestContext({
      prismaOverrides: {
        webhookDelivery: { create: async () => ({}) },
        webhookEndpoint: {
          update: async (args: unknown) => {
            const data = (args as { data: Record<string, unknown> }).data;
            if ('enabled' in data && data.enabled === false) disabled = true;
            if ('failureCount' in data)
              return { failureCount: OUTBOUND_AUTO_DISABLE_THRESHOLD, enabled: true };
            return { failureCount: OUTBOUND_AUTO_DISABLE_THRESHOLD, enabled: !disabled };
          },
        },
      },
    });

    const endpoint = makeEndpoint({ failureCount: OUTBOUND_AUTO_DISABLE_THRESHOLD - 1 });
    const result = await attemptOutboundDelivery(
      ctx,
      endpoint as never,
      { event: 'moderation.caseCreated' },
      1,
    );

    expect(result.delivered).toBe(false);
    expect(disabled).toBe(true);
  });
});
