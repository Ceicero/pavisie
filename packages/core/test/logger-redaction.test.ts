import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { LOGGER_OPTIONS } from '../src/logger';

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
    log.info({ msg: { content: 'hello there', token: 'abc123' } }, 'x');
    expect(lines()).not.toContain('hello there');
    expect(lines()).not.toContain('abc123');
  });
});
