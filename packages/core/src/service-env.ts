// Per-service startup environment check. Deliberately dependency-light (zod only — no `./env`, no logger, no
// ioredis) so the Next.js apps can import it from `instrumentation.ts` via `@pavisie/core/service-env` without
// dragging the bot/api runtime into their bundles, and so importing it never triggers `env.ts`'s import-time
// parse. Callers that want a `.env` file loaded (bot, api) call `loadEnv()` first.
import { z } from 'zod';

/** The deployable services that run a startup check. */
export type ServiceName = 'bot' | 'api' | 'dashboard' | 'web';

/** One failed variable: its NAME and a static, value-free reason. */
export interface EnvProblem {
  name: string;
  reason: string;
}

// Every message below is a fixed string. Nothing derived from a variable's value ever reaches a message — see
// `checkServiceEnv`, which also discards zod's own (value-bearing) default messages.
const MISSING = 'missing';

const required = () => z.string({ required_error: MISSING, invalid_type_error: MISSING });

function urlWithProtocols(protocols: readonly string[]): (value: string) => boolean {
  return (value) => {
    try {
      return protocols.includes(new URL(value).protocol);
    } catch {
      return false;
    }
  };
}

const isHttpUrl = urlWithProtocols(['http:', 'https:']);
const isRedisUrl = urlWithProtocols(['redis:', 'rediss:']);
const isPostgresUrl = urlWithProtocols(['postgres:', 'postgresql:']);

const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/;
const KEY_BYTES = 32;

/** Mirrors `parseKey` in `crypto/encryption.ts`: 64 lowercase hex chars, or base64 that decodes to 32 bytes. */
function isEncryptionKey(value: string): boolean {
  const trimmed = value.trim();
  const buf = HEX_KEY_PATTERN.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  return buf.length === KEY_BYTES;
}

/** `TRUST_PROXY` as accepted by `env.ts`: `true`, `false`, or a non-negative hop count. */
function isTrustProxy(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed === 'true' || trimmed === 'false' || /^\d+$/.test(trimmed);
}

const httpUrl = () => z.string().refine(isHttpUrl, 'must be an absolute http:// or https:// URL');
const port = () =>
  z
    .string()
    .refine(
      (v) => /^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 65535,
      'must be an integer between 1 and 65535',
    );
const encryptionKey = () =>
  z
    .string()
    .refine(
      isEncryptionKey,
      'must be 32 bytes, base64-encoded (or 64 lowercase hex characters); generate one with: openssl rand -base64 32',
    );
const discordId = () => z.string().refine((v) => /^\d{1,20}$/.test(v.trim()), 'must be a numeric Discord ID');
const oneOf = <T extends [string, ...string[]]>(values: T) =>
  z.enum(values, { errorMap: () => ({ message: `must be one of: ${values.join(', ')}` }) });

const postgresUrl = () =>
  z.string().refine(isPostgresUrl, 'must be a postgres:// or postgresql:// connection URL');
const redisUrl = () => z.string().refine(isRedisUrl, 'must be a redis:// or rediss:// connection URL');

/*
 * What each service REALLY needs to run (not what the docs recommend):
 *
 * - "required" = the process cannot do its job without it today (this is exactly what the previous
 *   `requireEnv(...)` lists enforced, so no working deployment is newly rejected for a *missing* variable).
 * - everything else is optional, but if it is set it must be well-formed, because a malformed value is always a
 *   misconfiguration (a bad URL in the CORS allowlist, a port that cannot be bound, a key that cannot decrypt).
 *
 * Empty strings count as "not set" (`.env.example` ships many blank lines).
 */
const schemas: Record<ServiceName, z.ZodObject<z.ZodRawShape>> = {
  bot: z.object({
    DISCORD_TOKEN: required(),
    DISCORD_CLIENT_ID: required().pipe(discordId()),
    DATABASE_URL: required().pipe(postgresUrl()),
    REDIS_URL: required().pipe(redisUrl()),
    ENCRYPTION_KEY: encryptionKey().optional(),
    ENCRYPTION_KEY_PREVIOUS: encryptionKey().optional(),
    BOT_HEALTH_PORT: port().optional(),
    REGISTER_COMMANDS_ON_BOOT: oneOf(['off', 'global', 'guild']).optional(),
    WEB_URL: httpUrl().optional(),
  }),
  api: z.object({
    DATABASE_URL: required().pipe(postgresUrl()),
    REDIS_URL: required().pipe(redisUrl()),
    DISCORD_CLIENT_ID: required().pipe(discordId()),
    DISCORD_CLIENT_SECRET: required(),
    SESSION_SECRET: required(),
    ENCRYPTION_KEY: required().pipe(encryptionKey()),
    DISCORD_OAUTH_REDIRECT_URI: required().pipe(httpUrl()),
    DASHBOARD_URL: required().pipe(httpUrl()),
    ENCRYPTION_KEY_PREVIOUS: encryptionKey().optional(),
    API_PORT: port().optional(),
    API_BASE_URL: httpUrl().optional(),
    WEB_URL: httpUrl().optional(),
    PUBLIC_WEBHOOK_BASE_URL: httpUrl().optional(),
    KOFI_URL: httpUrl().optional(),
    SESSION_COOKIE_SAMESITE: oneOf(['lax', 'none']).optional(),
    TRUST_PROXY: z
      .string()
      .refine(isTrustProxy, 'must be true, false, or a non-negative hop count such as 1')
      .optional(),
  }),
  // The legacy app.pavisie.com redirector. Its only inputs have safe fallbacks (and WEB_URL is baked in at build
  // time), so nothing is required; malformed values are still rejected.
  dashboard: z.object({
    NEXT_PUBLIC_API_URL: httpUrl().optional(),
    WEB_URL: httpUrl().optional(),
  }),
  // The marketing site + /dashboard/** UI. Every variable has a built-in fallback or degrades gracefully when
  // unset (see apps/web/src/lib/site.ts and middleware.ts), so nothing is required.
  web: z.object({
    NEXT_PUBLIC_API_URL: httpUrl().optional(),
    NEXT_PUBLIC_SITE_URL: httpUrl().optional(),
    NEXT_PUBLIC_SUPPORT_SERVER_URL: httpUrl().optional(),
    NEXT_PUBLIC_DISCORD_CLIENT_ID: discordId().optional(),
    WEB_URL: httpUrl().optional(),
  }),
};

/** Names of the variables a service must have set (everything else in its schema is optional-but-validated). */
export function requiredEnvNames(service: ServiceName): string[] {
  const shape = schemas[service].shape;
  return Object.keys(shape).filter((key) => !shape[key]!.isOptional());
}

/**
 * Validates `source` (default `process.env`) against the schema for `service`. Returns one problem per
 * offending variable — name plus a fixed reason, never a value — or an empty array when everything is fine.
 */
export function checkServiceEnv(
  service: ServiceName,
  source: Record<string, string | undefined> = process.env,
): EnvProblem[] {
  const schema = schemas[service];
  const cleaned: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = source[key];
    // Blank / whitespace-only means "not set", same as `requireEnv`.
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value;
  }

  const result = schema.safeParse(cleaned);
  if (result.success) return [];

  const seen = new Set<string>();
  const problems: EnvProblem[] = [];
  for (const issue of result.error.issues) {
    const name = String(issue.path[0] ?? '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    // Only our own fixed messages are trusted: zod's built-in messages for other issue kinds can quote the
    // offending value (e.g. "Invalid enum value ... received 'x'"), so those collapse to a generic reason.
    const trusted =
      issue.code === 'custom' || issue.message === MISSING || issue.message.startsWith('must be ');
    problems.push({ name, reason: trusted ? issue.message : 'is invalid' });
  }
  return problems;
}

/** Renders the single multi-line startup-failure message. Contains variable names and fixed reasons only. */
export function formatEnvProblems(service: ServiceName, problems: readonly EnvProblem[]): string {
  const lines = problems.map((p) => `  - ${p.name}: ${p.reason}`);
  return [
    `[pavisie:${service}] Refusing to start: ${problems.length} environment variable${problems.length === 1 ? ' is' : 's are'} missing or invalid.`,
    ...lines,
    `Fix: set ${problems.length === 1 ? 'it' : 'them'} on the "${service}" service (Railway: service > Variables; locally: .env). ` +
      'Values are never printed here. See .env.example and infra/DEPLOYMENT.md (section 6, Environment variable reference).',
  ].join('\n');
}

export interface AssertServiceEnvOptions {
  /** Where to print the message. Defaults to `console.error`. */
  print?: (message: string) => void;
  /** What to do after printing. Defaults to `process.exit(1)`. */
  exit?: (code: number) => never;
}

/**
 * Startup gate: when `service`'s environment is missing or malformed, prints ONE message naming the service and
 * every offending variable (names and reasons only, never values) and exits the process with code 1.
 */
export function assertServiceEnv(
  service: ServiceName,
  source: Record<string, string | undefined> = process.env,
  options: AssertServiceEnvOptions = {},
): void {
  const problems = checkServiceEnv(service, source);
  if (problems.length === 0) return;
  const print = options.print ?? ((message: string) => console.error(message));
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  print(formatEnvProblems(service, problems));
  exit(1);
}
