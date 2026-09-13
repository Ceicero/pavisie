import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/build-test-app';

// The counterpart "NOT served in production" case lives in `docs-route-production.test.ts` — it needs
// `NODE_ENV=production` set before `@pavisie/core` is first imported (see that file's header comment for why
// that means it can't live in this file too).
describe('GET /docs (Swagger UI) outside production', () => {
  it('is served when NODE_ENV=test (the default test env — see test/setup.ts)', async () => {
    const { app } = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/docs' });

    expect(res.statusCode).not.toBe(404);
    expect(res.headers['content-type']).toContain('text/html');

    await app.close();
  });
});
