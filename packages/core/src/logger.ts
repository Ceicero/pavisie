import pino, { type Logger, type LoggerOptions } from 'pino';
import { env, isProduction } from './env';

const REDACT_PATHS = [
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.password',
  '*.secret',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.content',
  '*.messageContent',
  '*.apiKey',
  // discord.js REST errors carry the outgoing request (message text, embeds, files) as `err.requestBody`.
  '*.requestBody',
];

const usePretty = !isProduction && Boolean(process.stdout.isTTY);

/** Exported for tests. */
export const LOGGER_OPTIONS: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  // Emit `"level":"warn"` instead of pino's numeric `"level":40`: Railway's log viewer only understands level
  // names, so with numbers every warn/error line showed up (and filtered) as info.
  formatters: { level: (label) => ({ level: label }) },
  ...(usePretty
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } } }
    : {}),
};

/** Root process logger. Redacts tokens/secrets/message content; pretty-printed only in non-production TTYs. */
export const logger: Logger = pino(LOGGER_OPTIONS);

/** Returns a child logger scoped to a named module (`{ module: name }`). */
export function createLogger(name: string): Logger {
  return logger.child({ module: name });
}
