import { describe, expect, it } from 'vitest';
import { decryptSecret } from '@pavisie/core';
import { buildTestApp, loginAs, seedUserGuilds } from './helpers/build-test-app';

const GUILD_ID = '666666666666666666';
const USER_ID = '777777777777777777';

/** Minimal stateful `PluginConfig` fake so GET reflects what a prior PUT stored, like the real Postgres-backed store. */
function pluginConfigOverrides() {
  const store = new Map<string, Record<string, unknown>>();
  const keyOf = (guildId: string, pluginId: string) => `${guildId}:${pluginId}`;

  return {
    store,
    overrides: {
      pluginConfig: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake, args shape mirrors Prisma's generated types
        findUnique: async (args: any) => {
          const { guildId, pluginId } = args.where.guildId_pluginId;
          const config = store.get(keyOf(guildId, pluginId));
          return config ? { config } : null;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
        upsert: async (args: any) => {
          const { guildId, pluginId } = args.where.guildId_pluginId;
          store.set(keyOf(guildId, pluginId), args.create.config);
          return { config: args.create.config };
        },
      },
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    },
  };
}

async function setUpAuthedApp() {
  const { overrides } = pluginConfigOverrides();
  const { app, redis, prisma, prismaCalls, queues } = await buildTestApp(overrides);
  const { cookieHeader, session } = await loginAs(app, redis, { userId: USER_ID });
  await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);
  const mutHeaders = {
    cookie: cookieHeader,
    origin: 'http://localhost:3000',
    'x-csrf-token': session.csrfToken,
  };
  return { app, redis, prisma, prismaCalls, queues, cookieHeader, mutHeaders };
}

describe('GET /guilds/:guildId/ai/settings', () => {
  it('returns platform defaults and hasKey:false when nothing has been configured yet', async () => {
    const { app, cookieHeader } = await setUpAuthedApp();

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/ai/settings`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      guildId: GUILD_ID,
      provider: 'openai',
      model: 'gpt-4o-mini',
      hasKey: false,
      allowEnvKeys: true,
      allowedChannelIds: [],
      userCooldownSeconds: 30,
      dailyTokenBudget: 200_000,
      perUserDailyTokenBudget: 20_000,
    });
    expect(body.apiKeyEnc).toBeUndefined();

    await app.close();
  });
});

describe('PUT /guilds/:guildId/ai/settings', () => {
  it('encrypts a provided apiKey, never returns it in plaintext or ciphertext, and hasKey flips to true', async () => {
    const { app, mutHeaders, prisma } = await setUpAuthedApp();

    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/ai/settings`,
      headers: mutHeaders,
      payload: { apiKey: 'sk-super-secret-value', provider: 'openai', model: 'gpt-4o-mini' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-super-secret-value');
    expect(body.apiKeyEnc).toBeUndefined();

    // The stored config really does hold an encrypted (not plaintext) value that decrypts back correctly.
    const stored = await prisma.pluginConfig.findUnique({
      where: { guildId_pluginId: { guildId: GUILD_ID, pluginId: 'ai' } },
    });
    const storedConfig = stored!.config as { apiKeyEnc: string };
    expect(storedConfig.apiKeyEnc).not.toBe('sk-super-secret-value');
    expect(storedConfig.apiKeyEnc.startsWith('v1:')).toBe(true);
    expect(decryptSecret(storedConfig.apiKeyEnc)).toBe('sk-super-secret-value');

    await app.close();
  });

  it('clearKey removes a previously-set key', async () => {
    const { app, mutHeaders } = await setUpAuthedApp();

    await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/ai/settings`,
      headers: mutHeaders,
      payload: { apiKey: 'sk-abc' },
    });
    const cleared = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/ai/settings`,
      headers: mutHeaders,
      payload: { clearKey: true },
    });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().hasKey).toBe(false);

    await app.close();
  });

  it('rejects an unauthenticated request', async () => {
    const { app } = await setUpAuthedApp();
    const res = await app.inject({ method: 'GET', url: `/guilds/${GUILD_ID}/ai/settings` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a mutating request missing the CSRF header', async () => {
    const { app, cookieHeader } = await setUpAuthedApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/ai/settings`,
      headers: { cookie: cookieHeader, origin: 'http://localhost:3000' },
      payload: { model: 'gpt-4o' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects an out-of-range budget at the schema level', async () => {
    const { app, mutHeaders } = await setUpAuthedApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/ai/settings`,
      headers: mutHeaders,
      payload: { dailyTokenBudget: 1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a compatible-provider baseUrl pointing at a private/internal address (SSRF guard)', async () => {
    const { app, mutHeaders, prisma } = await setUpAuthedApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/ai/settings`,
      headers: mutHeaders,
      payload: { provider: 'compatible', baseUrl: 'http://169.254.169.254/latest/meta-data' },
    });
    expect(res.statusCode).toBe(400);

    const stored = await prisma.pluginConfig.findUnique({
      where: { guildId_pluginId: { guildId: GUILD_ID, pluginId: 'ai' } },
    });
    expect(stored).toBeNull();

    await app.close();
  });

  it('rejects a plain-http compatible-provider baseUrl', async () => {
    const { app, mutHeaders } = await setUpAuthedApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/guilds/${GUILD_ID}/ai/settings`,
      headers: mutHeaders,
      payload: { provider: 'compatible', baseUrl: 'http://llm.example.com' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /guilds/:guildId/ai/usage', () => {
  it('summarizes AiUsage rows into daily buckets and top commands, defaulting to a 30-day range', async () => {
    const { overrides } = pluginConfigOverrides();
    const now = new Date();
    const rows = [
      { command: 'ask', promptTokens: 100, completionTokens: 20, createdAt: now },
      { command: 'ask', promptTokens: 50, completionTokens: 10, createdAt: now },
      { command: 'summarize', promptTokens: 500, completionTokens: 100, createdAt: now },
    ];
    const { app, redis } = await buildTestApp({
      ...overrides,
      aiUsage: {
        findMany: async () => rows,
      },
      guild: { findUnique: async () => ({ id: GUILD_ID, botPresent: true }) },
    });
    const { cookieHeader } = await loginAs(app, redis, { userId: USER_ID });
    await seedUserGuilds(redis, USER_ID, [{ id: GUILD_ID, owner: true, permissions: '8' }]);

    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/ai/usage`,
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.guildId).toBe(GUILD_ID);
    expect(body.rangeDays).toBe(30);
    expect(body.totalRequests).toBe(3);
    expect(body.totalPromptTokens).toBe(650);
    expect(body.totalCompletionTokens).toBe(130);
    expect(body.daily).toHaveLength(1);
    expect(body.daily[0].requests).toBe(3);
    expect(body.daily[0].totalTokens).toBe(780);
    expect(body.topCommands[0]).toEqual({ command: 'summarize', requests: 1, totalTokens: 600 });
    expect(body.topCommands[1]).toEqual({ command: 'ask', requests: 2, totalTokens: 180 });

    await app.close();
  });

  it('returns zeroed totals with no rows', async () => {
    const { app, cookieHeader } = await setUpAuthedApp();
    const res = await app.inject({
      method: 'GET',
      url: `/guilds/${GUILD_ID}/ai/usage`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      totalRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      daily: [],
      topCommands: [],
    });
    await app.close();
  });
});

describe('POST /guilds/:guildId/ai/test', () => {
  it('enqueues an ai.test bot-action job and responds 202', async () => {
    const { app, mutHeaders, queues } = await setUpAuthedApp();

    const res = await app.inject({ method: 'POST', url: `/guilds/${GUILD_ID}/ai/test`, headers: mutHeaders });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ ok: true });

    expect(queues.calls).toHaveLength(1);
    expect(queues.calls[0]).toMatchObject({
      queue: 'bot-actions',
      name: 'bot-action',
      data: { type: 'ai.test', guildId: GUILD_ID, requestedBy: USER_ID },
    });

    await app.close();
  });

  it('rejects an unauthenticated request', async () => {
    const { app } = await setUpAuthedApp();
    const res = await app.inject({ method: 'POST', url: `/guilds/${GUILD_ID}/ai/test` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
