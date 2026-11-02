import { describe, expect, it } from 'vitest';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '555555555555555555';
const USER_ID = '666666666666666666';
const REQUEST_ID = 'export-req-1';

async function setUpAuthedApp(prismaOverrides: Record<string, unknown> = {}) {
  const { app, redis, prisma, prismaCalls } = await buildTestApp({
    guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    ...prismaOverrides,
  });
  const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  return { app, cookieHeader, prisma, prismaCalls };
}

describe('GET /guilds/:guildId/data/requests/:requestId/download', () => {
  it('streams the export JSON with a download-friendly Content-Disposition when the request is completed', async () => {
    const { app, cookieHeader, prismaCalls } = await setUpAuthedApp({
      dataRequest: {
        findFirst: async () => ({
          id: REQUEST_ID,
          guildId: GUILD_ID,
          type: 'EXPORT',
          status: 'DONE',
          resultExpiresAt: new Date(Date.now() + 86_400_000),
        }),
      },
      dataExportBlob: {
        findUnique: async () => ({ requestId: REQUEST_ID, content: '{"guild":{"id":"555555555555555555"}}' }),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/data/requests/${REQUEST_ID}/download`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body).toContain('555555555555555555');
    const audit = prismaCalls.find((c) => c.model === 'auditLog' && c.method === 'create');
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit!.args)).toContain('data.export.download');
    expect(JSON.stringify(audit!.args)).toContain(USER_ID);

    await app.close();
  });

  it('rejects downloading a request that is still pending', async () => {
    const { app, cookieHeader } = await setUpAuthedApp({
      dataRequest: {
        findFirst: async () => ({
          id: REQUEST_ID,
          guildId: GUILD_ID,
          type: 'EXPORT',
          status: 'PENDING',
          resultExpiresAt: null,
        }),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/data/requests/${REQUEST_ID}/download`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('404s for a request id that does not belong to this guild', async () => {
    const { app, cookieHeader } = await setUpAuthedApp({
      dataRequest: { findFirst: async () => null },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/data/requests/${REQUEST_ID}/download`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects an expired export link', async () => {
    const { app, cookieHeader } = await setUpAuthedApp({
      dataRequest: {
        findFirst: async () => ({
          id: REQUEST_ID,
          guildId: GUILD_ID,
          type: 'EXPORT',
          status: 'DONE',
          resultExpiresAt: new Date(Date.now() - 1000),
        }),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/data/requests/${REQUEST_ID}/download`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
