import { describe, expect, it } from 'vitest';
import { redisKey } from '@pavisie/core';
import { buildTestApp } from './helpers/build-test-app';

const TOKEN = 'test-verify-token-123';

describe('GET /verify/:token', () => {
  it("serves the widget page with a CSP whose script-src nonce matches the inline <script>'s nonce attribute", async () => {
    const { app, redis } = await buildTestApp();
    await redis.set(
      redisKey('verify', 'pending', TOKEN),
      JSON.stringify({ guildId: '1', userId: '2' }),
      'EX',
      600,
    );

    const res = await app.inject({ method: 'GET', url: `/verify/${TOKEN}` });

    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toBeDefined();

    const nonceMatch = /'nonce-([^']+)'/.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const nonce = nonceMatch![1];

    // The inline script that defines window.onVerify must carry the exact same nonce, or the browser
    // refuses to execute it under this CSP and the widget can never complete.
    expect(res.body).toContain(`<script nonce="${nonce}">`);

    await app.close();
  });

  it('returns the expired page (still with a valid CSP) when the token has no pending entry', async () => {
    const { app } = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: `/verify/does-not-exist` });

    expect(res.statusCode).toBe(410);
    expect(res.headers['content-security-policy']).toBeDefined();

    await app.close();
  });
});
