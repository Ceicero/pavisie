import { Writable } from 'node:stream';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOGGER_OPTIONS } from '@pavisie/core';
import { createPrismaStub } from '@pavisie/plugins/sdk/testing';
import { buildApp } from '../src/app';
import { loggablePath, serializeRequest } from '../src/lib/request-log';
import { createFakeQueues } from './helpers/build-test-app';

const TOKEN = 'cap-token-3f9a1c7e5b2d4f6a8c0e';

interface LogLine {
  msg?: string;
  req?: { method: string; url: string; route?: string };
}

/** The real app with the real logger options, writing to memory, so the lines are what production would emit. */
async function appWithCapturedLogs() {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  const logger = pino({ ...LOGGER_OPTIONS, level: 'info', transport: undefined }, sink);
  const app = await buildApp({
    prisma: createPrismaStub().prisma,
    redis: new RedisMock() as unknown as Redis,
    overlaySubscriber: new RedisMock() as unknown as Redis,
    queues: createFakeQueues(),
    logger,
  });
  await app.ready();
  const lines = (): LogLine[] =>
    out
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogLine);
  const incoming = (): NonNullable<LogLine['req']>[] =>
    lines()
      .filter((line) => line.msg === 'incoming request')
      .map((line) => line.req!);
  return { app, raw: () => out, incoming };
}

describe('API request logging', () => {
  it('masks the capability token on the verify and overlay routes and logs the route pattern', async () => {
    const { app, raw, incoming } = await appWithCapturedLogs();
    await app.inject({ method: 'GET', url: `/verify/${TOKEN}` });
    await app.inject({ method: 'GET', url: `/overlay/${TOKEN}` });
    await app.inject({ method: 'GET', url: `/overlay/${TOKEN}/tts/audio-1?cache=${TOKEN}` });
    expect(raw()).not.toContain(TOKEN);
    expect(incoming()).toEqual([
      expect.objectContaining({ method: 'GET', url: '/verify/[REDACTED]', route: '/verify/:token' }),
      expect.objectContaining({ method: 'GET', url: '/overlay/[REDACTED]', route: '/overlay/:token' }),
      expect.objectContaining({
        url: '/overlay/[REDACTED]/tts/audio-1',
        route: '/overlay/:token/tts/:audioId',
      }),
    ]);
    await app.close();
  });

  it('never logs the query string, so OAuth code and state stay out of the logs', async () => {
    const { app, raw, incoming } = await appWithCapturedLogs();
    await app.inject({
      method: 'GET',
      url: '/auth/discord/callback?code=oauth-code-123&state=oauth-state-456',
    });
    await app.inject({
      method: 'GET',
      url: '/integrations/twitch/callback?code=oauth-code-123&state=oauth-state-456',
    });
    expect(raw()).not.toContain('oauth-code-123');
    expect(raw()).not.toContain('oauth-state-456');
    expect(incoming().map((req) => req.url)).toEqual([
      '/auth/discord/callback',
      '/integrations/twitch/callback',
    ]);
    expect(incoming()[1]!.route).toBe('/integrations/:provider/callback');
    await app.close();
  });

  it('masks a token on a path that matches no route (404), and keeps ordinary ids', async () => {
    const { app, raw, incoming } = await appWithCapturedLogs();
    await app.inject({ method: 'GET', url: `/overlay/${TOKEN}/no/such/route?x=1` });
    await app.inject({ method: 'GET', url: '/guilds/123456789012345678/moderation/cases?limit=5' });
    expect(raw()).not.toContain(TOKEN);
    const [missing, cases] = incoming();
    expect(missing!.url).toBe('/overlay/[REDACTED]/no/such/route');
    for (const url of [
      `//overlay/${TOKEN}`,
      `/Overlay/${TOKEN}`,
      `/VERIFY/${TOKEN}/x`,
      `/overlay//${TOKEN}`,
    ]) {
      await app.inject({ method: 'GET', url });
    }
    expect(raw()).not.toContain(TOKEN);
    expect(raw()).not.toContain('not found');
    expect(cases).toMatchObject({
      url: '/guilds/123456789012345678/moderation/cases',
      route: '/guilds/:guildId/moderation/cases',
    });
    await app.close();
  });
});

describe('serializeRequest', () => {
  it('keeps the fields of the default Fastify serializer', () => {
    expect(
      serializeRequest({
        method: 'POST',
        url: '/health?probe=1',
        headers: { 'accept-version': '1.x' },
        host: 'api.test',
        ip: '203.0.113.9',
        socket: { remotePort: 4242 },
        routeOptions: { url: '/health' },
      }),
    ).toEqual({
      method: 'POST',
      url: '/health',
      route: '/health',
      version: '1.x',
      host: 'api.test',
      remoteAddress: '203.0.113.9',
      remotePort: 4242,
    });
  });

  it('masks a percent-encoded token, and falls back to the pattern when the token cannot be located', () => {
    expect(
      loggablePath({
        url: '/verify/a%2Fb',
        params: { token: 'a/b' },
        routeOptions: { url: '/verify/:token' },
      }),
    ).toBe('/verify/[REDACTED]');
    expect(
      loggablePath({
        url: '/verify/%61bc',
        params: { token: 'abc' },
        routeOptions: { url: '/verify/:token' },
      }),
    ).toBe('/verify/:token');
  });
});
