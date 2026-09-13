import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, loginAs } from './helpers/build-test-app';

// `requireBotOwner` (apps/api/src/lib/bot-owner.ts) deliberately re-reads `process.env.BOT_OWNER_IDS` on every
// request rather than `@pavisie/core`'s cached `env` singleton, specifically so tests can flip the allowlist
// per-case with a plain assignment like this — no module-cache reset or dynamic import dance needed.
const ORIGINAL_BOT_OWNER_IDS = process.env.BOT_OWNER_IDS;

afterEach(() => {
  if (ORIGINAL_BOT_OWNER_IDS === undefined) {
    delete process.env.BOT_OWNER_IDS;
  } else {
    process.env.BOT_OWNER_IDS = ORIGINAL_BOT_OWNER_IDS;
  }
});

describe('requireBotOwner', () => {
  it('denies every request when the allowlist is unset (fails closed, never open)', async () => {
    delete process.env.BOT_OWNER_IDS;
    const { app, redis } = await buildTestApp();
    const { cookieHeader } = await loginAs(app, redis, { userId: 'some-user' });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/developer-reports',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'permission_denied' } });
    await app.close();
  });

  it('denies every request when the allowlist is set but empty/blank', async () => {
    process.env.BOT_OWNER_IDS = '   ';
    const { app, redis } = await buildTestApp();
    const { cookieHeader } = await loginAs(app, redis, { userId: 'some-user' });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/developer-reports',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('denies a logged-in user who is not in the allowlist', async () => {
    process.env.BOT_OWNER_IDS = 'owner-1,owner-2';
    const { app, redis } = await buildTestApp();
    const { cookieHeader } = await loginAs(app, redis, { userId: 'not-an-owner' });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/developer-reports',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows a user whose id is in the allowlist', async () => {
    process.env.BOT_OWNER_IDS = 'owner-1,owner-2';
    const { app, redis } = await buildTestApp();
    const { cookieHeader } = await loginAs(app, redis, { userId: 'owner-2' });

    const res = await app.inject({
      method: 'GET',
      url: '/owner/developer-reports',
      headers: { cookie: cookieHeader },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 401 (not 403) for an unauthenticated request, even with the allowlist set', async () => {
    process.env.BOT_OWNER_IDS = 'owner-1';
    const { app } = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/owner/developer-reports' });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
