import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOGGER_OPTIONS, redactDiscordTokens } from '../src/logger';

function capture(): { log: pino.Logger; lines: () => string } {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  return { log: pino({ ...LOGGER_OPTIONS, transport: undefined }, sink), lines: () => out };
}

describe('logger redaction', () => {
  it('drops the outgoing message body from a logged discord.js REST error', () => {
    const { log, lines } = capture();
    const err = Object.assign(new Error('Missing Permissions'), {
      code: 50013,
      status: 403,
      method: 'POST',
      url: 'https://discord.com/api/v10/channels/1/messages',
      requestBody: { json: { content: 'private user text', embeds: [{ description: 'secret' }] } },
    });
    log.error({ err }, 'send failed');
    const out = lines();
    expect(out).toContain('Missing Permissions');
    expect(out).toContain('50013');
    expect(out).not.toContain('private user text');
    expect(out).not.toContain('secret');
  });

  it('still redacts tokens and message content on plain objects', () => {
    const { log, lines } = capture();
    log.info({ data: { content: 'hello there', token: 'abc123' } }, 'x');
    expect(lines()).not.toContain('hello there');
    expect(lines()).not.toContain('abc123');
  });

  const WEBHOOK_TOKEN = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_webhooktoken';
  const INTERACTION_TOKEN = 'aW50ZXJhY3Rpb246MTIzNDU2Nzg5MDEyMzQ1Njc4OTpzZWNyZXQ';

  function restError(url: string, body = 'private user text'): Error {
    return Object.assign(new Error('Unknown Webhook'), {
      code: 10015,
      status: 404,
      method: 'POST',
      url,
      rawError: { message: 'Unknown Webhook', code: 10015 },
      requestBody: { json: { content: body } },
    });
  }

  it('masks the webhook token in err.url and keeps the rest of the route', () => {
    const { log, lines } = capture();
    log.error(
      {
        err: restError(
          `https://discord.com/api/v10/webhooks/123456789012345678/${WEBHOOK_TOKEN}/messages/@original`,
        ),
      },
      'edit failed',
    );
    const out = lines();
    expect(out).not.toContain(WEBHOOK_TOKEN);
    expect(out).toContain('/webhooks/123456789012345678/[REDACTED]/messages/@original');
  });

  it('masks the interaction token in err.url, also when the error is the first argument or under another key', () => {
    const url = `https://discord.com/api/v10/interactions/123456789012345678/${INTERACTION_TOKEN}/callback`;
    for (const write of [
      (log: pino.Logger) => log.error(restError(url), 'reply failed'),
      (log: pino.Logger) => log.error({ error: restError(url) }, 'reply failed'),
      (log: pino.Logger) => log.child({ module: 'x' }).warn({ err: restError(url) }, 'reply failed'),
    ]) {
      const { log, lines } = capture();
      write(log);
      expect(lines()).not.toContain(INTERACTION_TOKEN);
      expect(lines()).not.toContain('private user text');
      expect(lines()).toContain('/interactions/123456789012345678/[REDACTED]/callback');
    }
  });

  it('cleans an error nested deeper than one level', () => {
    const { log, lines } = capture();
    const err = restError(`https://discord.com/api/v10/webhooks/123456789012345678/${WEBHOOK_TOKEN}`);
    log.error({ ctx: { job: { err } } }, 'job failed');
    const out = lines();
    expect(out).toContain('Unknown Webhook');
    expect(out).not.toContain('private user text');
    expect(out).not.toContain(WEBHOOK_TOKEN);
  });

  it('cleans errors held by another error: a custom property, cause, and AggregateError.errors', () => {
    const url = `https://discord.com/api/v10/webhooks/123456789012345678/${WEBHOOK_TOKEN}`;
    const inner = Object.assign(new Error('wrapper'), { inner: restError(url, 'inner body') });
    const caused = new Error('with cause', { cause: restError(url, 'cause body') });
    const aggregate = new AggregateError(
      [restError(url, 'aggregate body one'), restError(url, 'aggregate body two')],
      'all failed',
    );
    const { log, lines } = capture();
    log.error({ err: inner }, 'a');
    log.error({ err: caused }, 'b');
    log.error({ err: aggregate }, 'c');
    log.error({ results: [{ err: aggregate }] }, 'd');
    const out = lines();
    for (const leaked of [
      'inner body',
      'cause body',
      'aggregate body one',
      'aggregate body two',
      WEBHOOK_TOKEN,
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('all failed');
    expect(out).toContain('Unknown Webhook');
  });

  it("keeps Discord's response (rawError), status and code so failures stay debuggable", () => {
    const { log, lines } = capture();
    log.error({ err: restError('https://discord.com/api/v10/channels/1/messages') }, 'send failed');
    const line = JSON.parse(lines()) as { err: Record<string, unknown> };
    // pino's standard serializer treats any object with a string `message` as error-like and adds `type`/`stack`.
    expect(line.err.rawError).toMatchObject({ message: 'Unknown Webhook', code: 10015 });
    expect(line.err).toMatchObject({ code: 10015, status: 404, method: 'POST', type: 'Error' });
    expect(line.err.url).toBe('https://discord.com/api/v10/channels/1/messages');
    expect(line.err.requestBody).toBe('[REDACTED]');
    expect(typeof line.err.stack).toBe('string');
  });

  it('does not mutate the logged objects, and survives circular references', () => {
    const { log, lines } = capture();
    const err = restError(`https://discord.com/api/v10/webhooks/123456789012345678/${WEBHOOK_TOKEN}`);
    const ctx: Record<string, unknown> = { err, requestBody: { keep: 'caller copy' } };
    ctx.self = ctx;
    log.error({ ctx }, 'x');
    expect(lines()).not.toContain(WEBHOOK_TOKEN);
    expect(lines()).not.toContain('caller copy');
    expect(ctx.requestBody).toEqual({ keep: 'caller copy' });
    expect((err as unknown as { url: string }).url).toContain(WEBHOOK_TOKEN);
    expect((err as unknown as { requestBody: unknown }).requestBody).toEqual({
      json: { content: 'private user text' },
    });
  });

  it('leaves ordinary Discord API paths and non-token strings alone', () => {
    expect(redactDiscordTokens('https://discord.com/api/v10/guilds/123456789012345678/webhooks')).toBe(
      'https://discord.com/api/v10/guilds/123456789012345678/webhooks',
    );
    expect(redactDiscordTokens('/webhooks/generic/abc')).toBe('/webhooks/generic/abc');
    expect(redactDiscordTokens('plain message')).toBe('plain message');
  });
});
