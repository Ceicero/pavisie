import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { env } from '@pavisie/core';
import { buildTestApp } from './helpers/build-test-app';

describe('GET /donations/config', () => {
  it('returns enabled:true and the Ko-fi URL when KOFI_URL is set', async () => {
    // Temporarily override the env to simulate KOFI_URL being set
    const originalKofiUrl = env.KOFI_URL;
    (env as any).KOFI_URL = 'https://ko-fi.com/example';

    try {
      const { app } = await buildTestApp();

      const res = await app.inject({ method: 'GET', url: '/donations/config' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        enabled: true,
        kofiUrl: 'https://ko-fi.com/example',
      });

      await app.close();
    } finally {
      (env as any).KOFI_URL = originalKofiUrl;
    }
  });

  it('returns enabled:false and null kofiUrl when KOFI_URL is not set', async () => {
    const originalKofiUrl = env.KOFI_URL;
    (env as any).KOFI_URL = undefined;

    try {
      const { app } = await buildTestApp();

      const res = await app.inject({ method: 'GET', url: '/donations/config' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        enabled: false,
        kofiUrl: null,
      });

      await app.close();
    } finally {
      (env as any).KOFI_URL = originalKofiUrl;
    }
  });
});
