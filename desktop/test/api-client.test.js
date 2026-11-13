import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { apiGet, buildRequestUrl } = require('../src/lib/api-client.cjs');
const { normalizeApiUrl } = require('../src/lib/api-url.cjs');
const { createSettingsStore, sanitizeSettings } = require('../src/lib/settings.cjs');

const API = 'https://api.example.test';
const reply = (status, body) => async () =>
  new Response(body === undefined ? 'not json' : JSON.stringify(body), { status });

test('normalizeApiUrl accepts https anywhere and http only on this machine', () => {
  assert.equal(normalizeApiUrl(' https://api.pavisie.com/some/path?x=1 '), 'https://api.pavisie.com');
  assert.equal(normalizeApiUrl('api.pavisie.com'), 'https://api.pavisie.com');
  assert.equal(normalizeApiUrl('http://localhost:3001/'), 'http://localhost:3001');
  assert.equal(normalizeApiUrl('http://127.0.0.1:3001'), 'http://127.0.0.1:3001');
  assert.throws(() => normalizeApiUrl('http://api.pavisie.com'), /https/);
  assert.throws(() => normalizeApiUrl('file:///etc/passwd'), /https/);
  assert.throws(() => normalizeApiUrl('https://user:pw@api.pavisie.com'), /username/);
  assert.throws(() => normalizeApiUrl(''), /Enter the address/);
});

test('buildRequestUrl only builds allowlisted read paths and query keys', () => {
  assert.equal(
    buildRequestUrl(API, '/owner/metrics/usage', { days: 30, cursor: undefined, query: '' }).href,
    `${API}/owner/metrics/usage?days=30`,
  );
  assert.throws(() => buildRequestUrl(API, '/owner/twitch-bot'), /not allowed/);
  assert.throws(() => buildRequestUrl(API, '/auth/logout'), /not allowed/);
  assert.throws(() => buildRequestUrl(API, 'https://evil.test/owner/metrics/usage'), /not allowed/);
  assert.throws(() => buildRequestUrl(API, '/owner/metrics/usage', { redirect: 'x' }), /not allowed/);
});

test('apiGet sends a GET with the session cookie and returns the data', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ points: [] }), { status: 200 });
  };
  const result = await apiGet({
    apiUrl: API,
    path: '/owner/metrics/growth',
    query: { days: 7 },
    cookieHeader: 'sid=abc',
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true, data: { points: [] } });
  assert.equal(calls[0].url, `${API}/owner/metrics/growth?days=7`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.cookie, 'sid=abc');
  assert.equal(calls[0].init.redirect, 'error');
});

test('apiGet explains each kind of failure instead of throwing', async () => {
  const get = (fetchImpl, path = '/owner/metrics/twitch') =>
    apiGet({ apiUrl: API, path, cookieHeader: '', fetchImpl });

  assert.equal(
    (await get(reply(401, { error: { message: 'Authentication required.' } }))).code,
    'signed_out',
  );
  const forbidden = await get(reply(403, {}));
  assert.equal(forbidden.code, 'not_owner');
  assert.match(forbidden.message, /BOT_OWNER_IDS/);
  const missing = await get(reply(404, {}));
  assert.equal(missing.code, 'not_deployed');
  assert.match(missing.message, /\/owner\/metrics\/twitch/);
  assert.equal((await get(reply(429, {}))).code, 'rate_limited');
  assert.deepEqual(await get(reply(500, { error: { message: 'Database is down.' } })), {
    ok: false,
    code: 'server_error',
    message: 'Database is down.',
  });
  assert.equal((await get(reply(200))).code, 'bad_response');
  const offline = await get(async () => {
    throw new TypeError('fetch failed');
  });
  assert.equal(offline.code, 'unreachable');
  assert.match(offline.message, /api\.example\.test/);
  assert.equal((await get(reply(200, {}), '/owner/secret')).code, 'not_allowed');
});

test('settings fall back to safe defaults and survive a round trip', () => {
  assert.deepEqual(
    sanitizeSettings({ apiUrl: 'http://evil.test', rangeDays: 12, autoRefresh: 'yes', extra: 1 }),
    {
      apiUrl: 'https://api.pavisie.com',
      rangeDays: 30,
      autoRefresh: true,
    },
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pavisie-dev-'));
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
    assert.equal(createSettingsStore(dir).load().rangeDays, 30);
    createSettingsStore(dir).save({ rangeDays: 90, apiUrl: 'http://localhost:3001' });
    assert.deepEqual(createSettingsStore(dir).load(), {
      apiUrl: 'http://localhost:3001',
      rangeDays: 90,
      autoRefresh: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
