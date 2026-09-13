import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptSecret, redisKey } from '@pavisie/core';
import { buildTestApp } from './helpers/build-test-app';
import {
  dispatchOverlayMessage,
  overlayConnectionCount,
  registerOverlayConnection,
  unregisterOverlayConnection,
  type OverlayConnection,
} from '../src/lib/overlay-registry';

const CHANNEL_ID = 'chan_overlay_test_1';
const TOKEN = 'overlay-token-abc123';

/** A `TwitchChatChannel` row whose `overlayTokenEnc` decrypts to `TOKEN` — exercises `resolveOverlayChannelId`'s
 * DB-fallback scan (the Redis index starts empty in every fresh `ioredis-mock`), and a hit there is what
 * repopulates the index for the fast path used by later requests/tests. */
function overlayChannelPrismaOverrides() {
  return {
    twitchChatChannel: {
      findMany: async () => [{ id: CHANNEL_ID, overlayTokenEnc: encryptSecret(TOKEN) }],
    },
  };
}

describe('GET /overlay/:token', () => {
  it("serves the overlay page with a CSP whose script-src nonce matches the inline <script>'s nonce attribute", async () => {
    const { app } = await buildTestApp(overlayChannelPrismaOverrides());

    const res = await app.inject({ method: 'GET', url: `/overlay/${TOKEN}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frame-options']).toBe('DENY');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toBeDefined();

    const nonceMatch = /'nonce-([^']+)'/.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const nonce = nonceMatch![1];

    // The inline script carries the exact same nonce, or the browser refuses to execute it under this CSP
    // and the overlay never opens its EventSource.
    expect(res.body).toContain(`<script nonce="${nonce}">`);

    await app.close();
  });

  it('returns 410 with the "no longer valid" page when the token does not resolve to any channel', async () => {
    const { app } = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/overlay/does-not-exist' });

    expect(res.statusCode).toBe(410);
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.body).toContain('no longer valid');

    await app.close();
  });
});

describe('GET /overlay/:token/stream', () => {
  it('returns 410 for an unknown token without hijacking the connection', async () => {
    const { app } = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/overlay/does-not-exist/stream' });

    expect(res.statusCode).toBe(410);

    await app.close();
  });
});

describe('GET /overlay/:token/tts/:audioId', () => {
  it('returns 410 for an unknown token', async () => {
    const { app } = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/overlay/does-not-exist/tts/abc123' });

    expect(res.statusCode).toBe(410);

    await app.close();
  });

  it('rejects an audioId outside the strict id pattern before it ever reaches Redis', async () => {
    const { app } = await buildTestApp(overlayChannelPrismaOverrides());

    const res = await app.inject({ method: 'GET', url: `/overlay/${TOKEN}/tts/${encodeURIComponent('bad:id')}` });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('serves the cached mp3 bytes for a valid token + audioId, then 404s once the Redis key is gone', async () => {
    const { app, redis } = await buildTestApp(overlayChannelPrismaOverrides());
    const audioId = randomUUID();
    const mp3Bytes = Buffer.from('fake-mp3-bytes-not-real-audio');
    await redis.set(redisKey('overlay', 'tts', CHANNEL_ID, audioId), mp3Bytes.toString('base64'), 'EX', 300);

    const res = await app.inject({ method: 'GET', url: `/overlay/${TOKEN}/tts/${audioId}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Buffer.from(res.rawPayload)).toEqual(mp3Bytes);

    // Simulate the 300s TTL having expired (same observable behavior as a real miss) rather than waiting.
    await redis.del(redisKey('overlay', 'tts', CHANNEL_ID, audioId));
    const expiredRes = await app.inject({ method: 'GET', url: `/overlay/${TOKEN}/tts/${audioId}` });
    expect(expiredRes.statusCode).toBe(404);

    await app.close();
  });

  it("cannot fetch another channel's audio: a valid token only resolves its OWN channel-scoped key", async () => {
    // Regression guard. The audio is a viewer's message spoken aloud, so it must never cross tenants. The
    // control is the channel scope in the Redis key, NOT the unguessability of `audioId` — this asserts that
    // holding a perfectly valid overlay token for channel A cannot reach audio synthesized for channel B,
    // even when the caller knows B's exact audioId.
    const { app, redis } = await buildTestApp(overlayChannelPrismaOverrides());
    const audioId = randomUUID();
    const otherChannelsAudio = Buffer.from('another-channels-private-tts-audio');
    await redis.set(
      redisKey('overlay', 'tts', 'chan_someone_else', audioId),
      otherChannelsAudio.toString('base64'),
      'EX',
      300,
    );

    const res = await app.inject({ method: 'GET', url: `/overlay/${TOKEN}/tts/${audioId}` });

    expect(res.statusCode).toBe(404);
    expect(Buffer.from(res.rawPayload).toString()).not.toContain('private-tts-audio');

    await app.close();
  });
});

/**
 * `/overlay/:token/stream` hijacks the raw Node response (`reply.hijack()` + `reply.raw`) precisely so it can
 * stay open and be written to later — which is fundamentally incompatible with `app.inject()`, whose returned
 * promise only resolves once a response finishes. So, per the task's own guidance, the connect / receive a
 * published event / cleanup-on-close behavior is exercised by driving `apps/api/src/lib/overlay-registry.ts`
 * directly: it's the exact same module the `/stream` route registers connections into and the same module
 * `app.ts`'s Redis-subscriber `pmessage` handler dispatches through, so this covers the real transport logic
 * end-to-end minus the live socket.
 */
describe('overlay-registry (drives the SSE transport directly — see comment above)', () => {
  it('writes a normalized SSE frame to every registered connection for a channel, and none after it is unregistered', () => {
    const channelId = 'chan_registry_test_sound';
    const writes: string[] = [];
    const conn: OverlayConnection = { write: (chunk) => writes.push(chunk) };

    registerOverlayConnection(channelId, conn);
    expect(overlayConnectionCount(channelId)).toBe(1);

    const written = dispatchOverlayMessage(
      channelId,
      JSON.stringify({ id: 'evt-1', kind: 'sound', url: 'https://cdn.example.com/air-horn.mp3', volume: 80 }),
    );

    expect(written).toBe(1);
    expect(writes).toEqual([
      'data: {"id":"evt-1","kind":"sound","url":"https://cdn.example.com/air-horn.mp3","volume":80}\n\n',
    ]);

    // Cleanup on close: after unregistering, further publishes for this channel reach nobody.
    unregisterOverlayConnection(channelId, conn);
    expect(overlayConnectionCount(channelId)).toBe(0);

    const writtenAfterCleanup = dispatchOverlayMessage(
      channelId,
      JSON.stringify({ id: 'evt-2', kind: 'sound', url: 'https://cdn.example.com/air-horn.mp3', volume: 80 }),
    );
    expect(writtenAfterCleanup).toBe(0);
    expect(writes).toHaveLength(1);
  });

  it('normalizes a TTS payload the same way, keyed on audioId rather than url', () => {
    const channelId = 'chan_registry_test_tts';
    const writes: string[] = [];
    const conn: OverlayConnection = { write: (chunk) => writes.push(chunk) };
    registerOverlayConnection(channelId, conn);

    dispatchOverlayMessage(channelId, JSON.stringify({ id: 'evt-3', kind: 'tts', audioId: 'aud-123', volume: 50 }));

    expect(writes).toEqual(['data: {"id":"evt-3","kind":"tts","audioId":"aud-123","volume":50}\n\n']);

    unregisterOverlayConnection(channelId, conn);
  });

  it('drops malformed or unrecognized payloads without writing to any connection', () => {
    const channelId = 'chan_registry_test_malformed';
    const writes: string[] = [];
    const conn: OverlayConnection = { write: (chunk) => writes.push(chunk) };
    registerOverlayConnection(channelId, conn);

    expect(dispatchOverlayMessage(channelId, 'not json')).toBe(0);
    expect(
      dispatchOverlayMessage(channelId, JSON.stringify({ kind: 'sound', url: 'https://x.test/a.mp3' })),
    ).toBe(0); // missing id
    expect(dispatchOverlayMessage(channelId, JSON.stringify({ id: 'x', kind: 'explode' }))).toBe(0); // unknown kind
    expect(writes).toHaveLength(0);

    unregisterOverlayConnection(channelId, conn);
  });
});
