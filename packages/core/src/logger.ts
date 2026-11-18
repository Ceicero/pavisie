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
 * Key names (lower-cased) whose values are censored at every depth by `scrubLogValue`. pino's `*.key` paths above
 * match exactly one level down, so a top-level `{ token }`, `{ a: { b: { apiKey } } }` or `{ a: [{ password }] }`
 * would otherwise be written as is. The pino paths stay as a second layer.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set(
  REDACT_PATHS.map((path) => path.slice(path.lastIndexOf('.') + 1).toLowerCase()),
);

/**
 * Discord puts the interaction or webhook token in the REST path (`/interactions/:id/:token/callback`,
 * `/webhooks/:id/:token[/…]`), and discord.js REST errors carry that path as `err.url`. Mask only the token segment
 * so the route stays readable in the logs. Webhook tokens never expire, so this matters most for them.
 */
const DISCORD_TOKEN_PATH = /(\/(?:webhooks|interactions)\/\d+\/)[A-Za-z0-9._~%-]{8,}/g;

/** Masks Discord interaction and webhook tokens inside a URL or any string that contains one. */
export function redactDiscordTokens(text: string): string {
  return text.includes('/webhooks/') || text.includes('/interactions/')
    ? text.replace(DISCORD_TOKEN_PATH, `$1${CENSOR}`)
    : text;
}

/** How deep `scrubLogValue` follows nested objects. Deeper values are replaced, never written unchecked. */
const MAX_SCRUB_DEPTH = 8;

/**
 * Cleans one logged value at any depth, which pino's path-based `redact` can't do (its `*.requestBody` wildcard
 * matches exactly one level):
 * - every `Error` becomes pino's standard serialized form (which also expands `AggregateError.errors` and nested
 *   error properties, and folds `cause` into the stack), then is cleaned like any other object;
 * - a secret-named key (`token`, `password`, `authorization`, `apiKey`, `cookie`, message `content`, `requestBody`
 *   and the rest of `REDACT_PATHS`, any letter case) is censored wherever it sits;
 * - strings have Discord interaction and webhook tokens masked;
 * - a `toJSON()` method is called here, so what it returns is cleaned too (a `URL` logs as its full href);
 * - class instances are walked like plain objects, since JSON writes their own enumerable properties the same way.
 * Copy-on-write: the caller's objects are never mutated, and an untouched value is returned as is.
 */
export function scrubLogValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactDiscordTokens(value);
  if (value === null || typeof value !== 'object') return value;
  // Binary data can't hold a readable token and can be huge.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (depth > MAX_SCRUB_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  try {
    if (value instanceof Error) return scrubObject(pino.stdSerializers.err(value), depth, seen);
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      // A Date gives a string and comes back unchanged in the output; anything else is cleaned as data.
      return scrubLogValue((toJSON as () => unknown).call(value), depth + 1, seen);
    }
    return scrubObject(value, depth, seen);
  } catch {
    // A throwing getter or toJSON must never take the log line (or the caller) down with it.
    return '[Unserializable]';
  } finally {
    seen.delete(value);
  }
}

function scrubObject(value: object, depth: number, seen: WeakSet<object>): unknown {
  const isArray = Array.isArray(value);
  let copy: Record<string, unknown> | unknown[] | undefined;
  for (const key of Object.keys(value)) {
    const before = (value as Record<string, unknown>)[key];
    let after: unknown;
    if (isArray) after = scrubLogValue(before, depth + 1, seen);
    else if (SECRET_KEYS.has(key.toLowerCase())) after = CENSOR;
    // A `toJSON` own property (set on an error, then copied by the serializer) would replace the cleaned object.
    else if (key === 'toJSON' && typeof before === 'function') after = undefined;
    else after = scrubLogValue(before, depth + 1, seen);
    if (after !== before) {
      copy ??= isArray ? [...value] : { ...value };
      (copy as Record<string, unknown>)[key] = after;
    }
  }
  return copy ?? value;
}

/** pino `err` serializer: the standard one, with nested request bodies and Discord tokens removed. */
export function serializeError(err: unknown): unknown {
  return scrubLogValue(err);
}

/**
 * Keys a framework hands to its own serializer, which picks a fixed set of safe fields (the API's `serializeRequest`
 * masks capability tokens in `url`; Fastify's `res` serializer keeps only `statusCode`). These are live class
 * instances whose fields are prototype getters, so a scrubbed copy would lose them: a censored `req.params.token`
 * left the request serializer with nothing to read. They pass through untouched, and the serializer's output is
 * what gets written.
 */
const SELF_SERIALIZED_KEYS: ReadonlySet<string> = new Set(['req', 'res']);

/** pino `formatters.log`: scrubs every top-level value except the self-serialized `req`/`res`. */
function scrubLogObject(object: Record<string, unknown>): Record<string, unknown> {
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(object)) {
    if (SELF_SERIALIZED_KEYS.has(key)) continue;
    const before = object[key];
    const after = SECRET_KEYS.has(key.toLowerCase()) ? CENSOR : scrubLogValue(before, 1);
    if (after !== before) {
      copy ??= { ...object };
      copy[key] = after;
    }
  }
  return copy ?? object;
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
    log: scrubLogObject,
  },
  hooks: {
    // The message text is not part of the object the formatter sees. pino takes it from the string arguments, or
    // from `err.message` when an error is logged on its own, and an error message can quote the request URL.
    logMethod(args, method) {
      const [first, ...rest] = args as unknown[];
      const cleaned = rest.map((arg) => (typeof arg === 'string' ? redactDiscordTokens(arg) : arg));
      if (typeof first === 'string')
        return method.apply(this, [redactDiscordTokens(first), ...cleaned] as never);
      if (first instanceof Error && cleaned.length === 0) {
        return method.apply(this, [first, redactDiscordTokens(first.message)] as never);
      }
      return method.apply(this, [first, ...cleaned] as never);
    },
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
