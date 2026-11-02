import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { REDACT_PATHS } from '../src/logger';

function capture(log: (logger: pino.Logger) => void): Record<string, unknown> {
  const lines: string[] = [];
  const logger = pino(
    { redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    { write: (line: string) => lines.push(line) },
  );
  log(logger);
  return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
}

describe('logger redaction', () => {
  it('drops the failed request body from a discord.js REST error, keeping code and message', () => {
    const err = Object.assign(new Error('Missing Access'), {
      code: 50001,
      requestBody: { files: undefined, json: { content: 'a private message' } },
    });
    const line = capture((logger) => logger.warn({ err }, 'send failed'));
    const logged = line.err as Record<string, unknown>;
    expect(logged.requestBody).toBe('[REDACTED]');
    expect(logged.code).toBe(50001);
    expect(logged.message).toBe('Missing Access');
    expect(JSON.stringify(line)).not.toContain('a private message');
  });
});
