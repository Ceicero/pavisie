import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import type { Client } from 'discord.js';
import { createCrashAlerter, installCrashHandlers } from '../crash-alerts';

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

describe('installCrashHandlers', () => {
  const added: Array<[string, (...args: unknown[]) => void]> = [];
  afterEach(() => {
    for (const [event, listener] of added.splice(0)) process.off(event, listener);
  });

  it('logs rejections at error, and an uncaught exception at fatal before exiting', async () => {
    const before = {
      rejection: process.listeners('unhandledRejection').length,
      exception: process.listeners('uncaughtException').length,
    };
    const { client, emitter } = fakeClient({ ready: false });
    const error = vi.spyOn(logger, 'error');
    const fatal = vi.spyOn(logger, 'fatal');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);

    installCrashHandlers({ client, logger, channelId: undefined });
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
      'discord client error',
      'discord shard error (websocket connection)',
    ]);
    expect(fatal).toHaveBeenCalledWith({ err, origin: 'uncaughtException' }, 'uncaughtException');
    expect(error).toHaveBeenCalledWith({ err, shardId: 0 }, expect.any(String));
    exit.mockRestore();
  });
});
