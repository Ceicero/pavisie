import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import type { Client } from 'discord.js';
import {
  createCrashAlerter,
  createCrashTerminator,
  installCrashHandlers,
  parseAlertWebhookUrl,
} from '../crash-alerts';

function fakeClient(opts: { ready?: boolean; send?: ReturnType<typeof vi.fn>; sendable?: boolean } = {}) {
  const send = opts.send ?? vi.fn().mockResolvedValue(undefined);
  const channel = { isSendable: () => opts.sendable ?? true, send };
  const fetch = vi.fn().mockResolvedValue(channel);
  const client = Object.assign(new EventEmitter(), {
    isReady: () => opts.ready ?? true,
    user: { tag: 'Pavisie#0001' },
    channels: { fetch },
  });
  return { client: client as unknown as Client, send, fetch, emitter: client };
}

const logger = pino({ enabled: false });

describe('createCrashAlerter', () => {
  it('does nothing when ALERT_CHANNEL_ID is not set', async () => {
    const { client, fetch } = fakeClient();
    const alert = createCrashAlerter({ client, logger, channelId: undefined });
    await alert('uncaughtException', new Error('boom'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does nothing before the client has logged in', async () => {
    const { client, fetch } = fakeClient({ ready: false });
    const alert = createCrashAlerter({ client, logger, channelId: 'alerts' });
    await alert('uncaughtException', new Error('boom'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts a short alert with the error to the configured channel, mentioning nobody', async () => {
    const { client, fetch, send } = fakeClient();
    const alert = createCrashAlerter({ client, logger, channelId: 'alerts' });
    await alert('unhandledRejection', new Error('database went away'));

    expect(fetch).toHaveBeenCalledWith('alerts');
    const payload = send.mock.calls[0]?.[0] as { content: string; allowedMentions: unknown };
    expect(payload.content).toContain('unhandledRejection');
    expect(payload.content).toContain('database went away');
    expect(payload.content.length).toBeLessThan(2000);
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('truncates a huge error to stay under the Discord message limit', async () => {
    const { client, send } = fakeClient();
    const alert = createCrashAlerter({ client, logger, channelId: 'alerts' });
    await alert('uncaughtException', 'x'.repeat(10_000));
    expect((send.mock.calls[0]?.[0] as { content: string }).content.length).toBeLessThan(2000);
  });

  it('posts at most one alert per kind per minute and reports how many it held back', async () => {
    let now = 0;
    const { client, send } = fakeClient();
    const alert = createCrashAlerter({ client, logger, channelId: 'alerts', now: () => now });

    await alert('unhandledRejection', new Error('1'));
    await alert('unhandledRejection', new Error('2'));
    await alert('unhandledRejection', new Error('3'));
    await alert('uncaughtException', new Error('other kind'));
    expect(send).toHaveBeenCalledTimes(2);

    now = 60_000;
    await alert('unhandledRejection', new Error('4'));
    expect(send).toHaveBeenCalledTimes(3);
    expect((send.mock.calls[2]?.[0] as { content: string }).content).toContain('2 more');
  });

  it('copes with a rejection reason that is not an Error and cannot be JSON-stringified', async () => {
    const { client, send } = fakeClient();
    const alert = createCrashAlerter({ client, logger, channelId: 'alerts' });
    const circular: Record<string, unknown> = { big: 1n };
    circular.self = circular;
    await expect(alert('unhandledRejection', circular)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never throws when posting the alert fails', async () => {
    const { client } = fakeClient({ send: vi.fn().mockRejectedValue(new Error('Missing Access')) });
    const warn = vi.spyOn(logger, 'warn');
    const alert = createCrashAlerter({ client, logger, channelId: 'alerts' });
    await expect(alert('uncaughtException', new Error('boom'))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'alerts' }), expect.any(String));
  });
});

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/s3cr3t-token_ABC';

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, status: 204 });
}

describe('parseAlertWebhookUrl', () => {
  it('accepts https discord.com and discordapp.com webhook URLs', () => {
    expect(parseAlertWebhookUrl(WEBHOOK, logger)).toBe(WEBHOOK);
    expect(parseAlertWebhookUrl('https://discordapp.com/api/webhooks/1/abc', logger)).toBeDefined();
    expect(parseAlertWebhookUrl('https://discord.com/api/v10/webhooks/1/abc', logger)).toBeDefined();
  });

  it('is silent when unset or blank', () => {
    const warn = vi.spyOn(logger, 'warn').mockClear();
    expect(parseAlertWebhookUrl(undefined, logger)).toBeUndefined();
    expect(parseAlertWebhookUrl('  ', logger)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['plain http', 'http://discord.com/api/webhooks/1/abc'],
    ['another host', 'https://evil.example/api/webhooks/1/abc'],
    ['a lookalike host', 'https://discord.com.evil.example/api/webhooks/1/abc'],
    ['a non-webhook discord path', 'https://discord.com/api/users/@me'],
    ['not a URL', 'not a url'],
  ])('rejects %s with a warning that does not contain the URL', (_name, url) => {
    const warn = vi.spyOn(logger, 'warn').mockClear();
    expect(parseAlertWebhookUrl(url, logger)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(url);
  });
});

describe('createCrashAlerter with ALERT_WEBHOOK_URL', () => {
  it('posts a Discord webhook payload that mentions nobody, even with no client at all', async () => {
    const fetch = okFetch();
    const alert = createCrashAlerter({ logger, webhookUrl: WEBHOOK, fetch });
    await alert('startupFailure', new Error('redis down'));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as { content: string; allowed_mentions: unknown };
    expect(body.content).toContain('startupFailure');
    expect(body.content).toContain('redis down');
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it('works while the gateway client is not ready, and skips the channel then', async () => {
    const fetch = okFetch();
    const { client, fetch: channelFetch } = fakeClient({ ready: false });
    const alert = createCrashAlerter({ client, logger, channelId: 'alerts', webhookUrl: WEBHOOK, fetch });
    await alert('uncaughtException', new Error('boom'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(channelFetch).not.toHaveBeenCalled();
  });

  it('posts to both the channel and the webhook when both are configured', async () => {
    const fetch = okFetch();
    const { client, send } = fakeClient();
    const alert = createCrashAlerter({ client, logger, channelId: 'alerts', webhookUrl: WEBHOOK, fetch });
    await alert('uncaughtException', new Error('boom'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores a bad webhook URL', async () => {
    const fetch = okFetch();
    const alert = createCrashAlerter({ logger, webhookUrl: 'http://example.com/hook', fetch });
    await alert('uncaughtException', new Error('boom'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('applies the same one-per-kind-per-minute throttle', async () => {
    let now = 0;
    const fetch = okFetch();
    const alert = createCrashAlerter({ logger, webhookUrl: WEBHOOK, fetch, now: () => now });
    await alert('unhandledRejection', new Error('1'));
    await alert('unhandledRejection', new Error('2'));
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 60_000;
    await alert('unhandledRejection', new Error('3'));
    expect(fetch).toHaveBeenCalledTimes(2);
    const second = JSON.parse((fetch.mock.calls[1]?.[1] as { body: string }).body) as { content: string };
    expect(second.content).toContain('1 more');
  });

  it('never throws and never logs the webhook URL when the post fails or is rejected', async () => {
    const warn = vi.spyOn(logger, 'warn').mockClear();
    const failing = createCrashAlerter({
      logger,
      webhookUrl: WEBHOOK,
      fetch: vi.fn().mockRejectedValue(new Error('network down')),
    });
    await expect(failing('uncaughtException', new Error('boom'))).resolves.toBeUndefined();
    const rejected = createCrashAlerter({
      logger,
      webhookUrl: WEBHOOK,
      fetch: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    });
    await expect(rejected('uncaughtException', new Error('boom'))).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('s3cr3t');
    expect(JSON.stringify(warn.mock.calls)).toContain('404');
  });
});

describe('createCrashTerminator', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('alerts, flushes the logger, then exits with code 1', async () => {
    const order: string[] = [];
    const alert = vi.fn(async () => {
      order.push('alert');
    });
    vi.spyOn(logger, 'flush').mockImplementation((cb) => {
      order.push('flush');
      cb?.();
    });
    const exit = vi.fn(() => {
      order.push('exit');
    });
    const terminate = createCrashTerminator({ alert, logger, exit });
    await terminate('uncaughtException', new Error('boom'));

    expect(alert).toHaveBeenCalledWith('uncaughtException', expect.any(Error));
    expect(order).toEqual(['alert', 'flush', 'exit']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits after the timeout when the alert hangs', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const terminate = createCrashTerminator({
      alert: () => new Promise<void>(() => undefined),
      logger,
      exit,
      timeoutMs: 3_000,
    });
    const pending = terminate('unhandledRejection', new Error('boom'));

    await vi.advanceTimersByTimeAsync(2_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits immediately on a second crash while the first is still being reported', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const alert = vi.fn(() => new Promise<void>(() => undefined));
    const terminate = createCrashTerminator({ alert, logger, exit });
    void terminate('uncaughtException', new Error('first'));
    expect(exit).not.toHaveBeenCalled();

    await terminate('unhandledRejection', new Error('second'));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('still exits when flushing the logger throws', async () => {
    vi.spyOn(logger, 'flush').mockImplementation(() => {
      throw new Error('stream closed');
    });
    const exit = vi.fn();
    await createCrashTerminator({ alert: () => Promise.resolve(), logger, exit })('watchdog', new Error('x'));
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('installCrashHandlers', () => {
  const added: Array<[string, (...args: unknown[]) => void]> = [];
  afterEach(() => {
    for (const [event, listener] of added.splice(0)) process.off(event, listener);
  });

  it('logs process crashes and client error/shardError events at error level, then exits with 1', async () => {
    const before = {
      rejection: process.listeners('unhandledRejection').length,
      exception: process.listeners('uncaughtException').length,
    };
    const { client, emitter } = fakeClient({ ready: false });
    const error = vi.spyOn(logger, 'error');

    const exit = vi.fn();
    installCrashHandlers({ client, logger, channelId: undefined, exit });
    const rejection = process.listeners('unhandledRejection').at(-1) as (...args: unknown[]) => void;
    const exception = process.listeners('uncaughtException').at(-1) as (...args: unknown[]) => void;
    added.push(['unhandledRejection', rejection], ['uncaughtException', exception]);
    expect(process.listeners('unhandledRejection')).toHaveLength(before.rejection + 1);
    expect(process.listeners('uncaughtException')).toHaveLength(before.exception + 1);

    const err = new Error('boom');
    rejection(err);
    exception(err, 'uncaughtException');
    emitter.emit('error', err);
    emitter.emit('shardError', err, 0);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(error.mock.calls.map((call) => call[1])).toEqual([
      'unhandledRejection',
      'uncaughtException',
      'discord client error',
      'discord shard error (websocket connection)',
    ]);
    expect(error).toHaveBeenCalledWith({ err, shardId: 0 }, expect.any(String));
  });
});
