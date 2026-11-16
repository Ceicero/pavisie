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

const CENSOR = '[REDACTED]';

/**
 * Discord puts the interaction or webhook token in the REST path (`/interactions/:id/:token/callback`,
 * `/webhooks/:id/:token[/…]`), and discord.js REST errors carry that path as `err.url`. Mask only the token segment
 * so the route stays readable in the logs. Webhook tokens never expire, so this matters most for them.
 */
const DISCORD_TOKEN_PATH = /(\/(?:webhooks|interactions)\/\d{5,25}\/)[A-Za-z0-9._~%-]{8,}/g;

/** Masks Discord interaction and webhook tokens inside a URL or any string that contains one. */
export function redactDiscordTokens(text: string): string {
  return text.includes('/webhooks/') || text.includes('/interactions/')
    ? text.replace(DISCORD_TOKEN_PATH, `$1${CENSOR}`)
    : text;
}

/** How deep `scrubLogValue` follows nested objects. Deeper values are replaced, never written unchecked. */
const MAX_SCRUB_DEPTH = 8;

/** pino's standard `err` serializer returns objects with its own prototype, at every level of a nested error. */
const SERIALIZED_ERROR_PROTO: unknown = Object.getPrototypeOf(pino.stdSerializers.err(new Error('probe')));

/** Plain data and pino-serialized errors are walked. Other class instances (Date, Buffer, …) are left alone. */
function isWalkable(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || proto === SERIALIZED_ERROR_PROTO;
}

/**
 * Cleans one logged value at any depth, which pino's path-based `redact` can't do (its `*.requestBody` wildcard
 * matches exactly one level):
 * - every `Error` becomes pino's standard serialized form (which also expands `AggregateError.errors` and nested
 *   error properties, and folds `cause` into the stack), then is cleaned like any other object;
 * - a `requestBody` key (the outgoing message a discord.js REST error carries) is censored wherever it sits;
 * - strings have Discord interaction and webhook tokens masked.
 * Copy-on-write: the caller's objects are never mutated, and an untouched value is returned as is.
 */
export function scrubLogValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactDiscordTokens(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_SCRUB_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';

  if (value instanceof Error) {
    seen.add(value);
    const serialized = scrubLogValue(pino.stdSerializers.err(value), depth, seen);
    seen.delete(value);
    return serialized;
  }
  const isArray = Array.isArray(value);
  if (!isArray && !isWalkable(value)) return value;

  seen.add(value);
  let copy: Record<string, unknown> | unknown[] | undefined;
  for (const key of Object.keys(value)) {
    const before = (value as Record<string, unknown>)[key];
    const after = !isArray && key === 'requestBody' ? CENSOR : scrubLogValue(before, depth + 1, seen);
    if (after !== before) {
      copy ??= isArray ? [...value] : { ...value };
      (copy as Record<string, unknown>)[key] = after;
    }
  }
  seen.delete(value);
  return copy ?? value;
}

/** pino `err` serializer: the standard one, with nested request bodies and Discord tokens removed. */
export function serializeError(err: unknown): unknown {
  return scrubLogValue(err);
}

const usePretty = !isProduction && Boolean(process.stdout.isTTY);

/**
 * Exported for tests.
 * @internal
 */
export const LOGGER_OPTIONS: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: CENSOR },
  // `serializers.err` covers `err` passed as a child logger's bindings. `formatters.log` covers every log call,
  // whatever key or depth the error sits at (`{ err }`, `{ error }`, `{ ctx: { err } }`, `AggregateError`), and
  // keeps working when a framework replaces the `err` serializer on a child (Fastify does).
  serializers: { err: serializeError },
  formatters: {
    // Emit `"level":"warn"` instead of pino's numeric `"level":40`: Railway's log viewer only understands level
    // names, so with numbers every warn/error line showed up (and filtered) as info.
    level: (label) => ({ level: label }),
    log: (object) => scrubLogValue(object) as Record<string, unknown>,
  },
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
