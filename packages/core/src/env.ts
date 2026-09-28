import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';
import { ConfigError } from './errors';

const MAX_WALK_LEVELS = 6;

let hasLoaded = false;

/**
 * Locates the repo root `.env` by walking up from `process.cwd()` (up to 6 levels) and loads it via dotenv.
 * Idempotent (safe to call more than once) and never overrides variables already present in `process.env`.
 * A missing `.env` file is not an error — env vars may come from the platform/Docker instead.
 */
export function loadEnv(): void {
  if (hasLoaded) return;
  hasLoaded = true;

  let dir = process.cwd();
  for (let level = 0; level < MAX_WALK_LEVELS; level++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate, override: false });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/** Builds a zod schema piece for a boolean env var stored as the string `'true'` / `'false'`. */
function boolFromString(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((value) => (value === undefined ? defaultValue : value.trim().toLowerCase() === 'true'));
}

/**
 * Builds the zod schema piece for `TRUST_PROXY`. Fastify's `trustProxy` option accepts either a boolean or a
 * hop-count number, so this parses `'true'`/`'false'` (kept for backward compatibility) as booleans and any
 * non-negative integer string as a hop count.
 *
 * A bare `true` trusts the *leftmost* address in a client-supplied `X-Forwarded-For` header — a value the
 * client fully controls — which makes per-IP rate limiting (and anything else keyed off `request.ip`) trivially
 * spoofable by just sending a fake `X-Forwarded-For`. A numeric hop count N instead trusts exactly N proxies,
 * counting from the *right* of the XFF chain, i.e. the entries appended by proxies you actually control; a
 * client cannot forge those. Production behind Railway (a single edge proxy in front of the app) should set
 * `TRUST_PROXY=1`.
 */
function trustProxyFromString(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((value): boolean | number => {
      if (value === undefined) return defaultValue;
      const trimmed = value.trim().toLowerCase();
      if (trimmed === 'true') return true;
      if (trimmed === 'false') return false;
      const hops = Number.parseInt(trimmed, 10);
      return Number.isInteger(hops) && hops >= 0 ? hops : defaultValue;
    });
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  DISCORD_OAUTH_REDIRECT_URI: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  API_PORT: z.coerce.number().int().positive().optional(),
  API_BASE_URL: z.string().optional(),
  DASHBOARD_URL: z.string().optional(),
  NEXT_PUBLIC_API_URL: z.string().optional(),
  WEB_URL: z.string().optional(),
  SESSION_COOKIE_SAMESITE: z.enum(['lax', 'none']).default('lax'),
  KOFI_URL: z.string().optional(),
  BRAND_LOGO_PATH: z.string().optional(),

  BOT_OWNER_IDS: z.string().optional(),
  DEV_GUILD_ID: z.string().optional(),
  /** off (default) | global | guild — when set, the bot bulk-registers its slash commands right after it logs in
   * ('guild' targets DEV_GUILD_ID and is instant; 'global' can take up to an hour to propagate). */
  REGISTER_COMMANDS_ON_BOOT: z.enum(['off', 'global', 'guild']).default('off'),
  BOT_HEALTH_PORT: z.coerce.number().int().positive().optional(),
  ENABLE_MESSAGE_CONTENT_INTENT: boolFromString(false),
  ENABLE_GUILD_MEMBERS_INTENT: boolFromString(true),
  ENABLE_GUILD_PRESENCES_INTENT: boolFromString(false),
  COMMAND_PREFIX: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return '+';
      const trimmed = value.trim();
      if (!trimmed) return '+';
      if (trimmed.length > 3) return '+';
      // Reject alphanumeric/whitespace to avoid matching ordinary chat
      if (/[a-zA-Z0-9\s]/.test(trimmed)) return '+';
      return trimmed;
    }),
  COOKIE_DOMAIN: z.string().optional(),
  TRUST_PROXY: trustProxyFromString(false),
  E2E_TEST_MODE: boolFromString(false),

  TWITCH_CLIENT_ID: z.string().optional(),
  TWITCH_CLIENT_SECRET: z.string().optional(),
  TWITCH_EVENTSUB_SECRET: z.string().optional(),
  // Twitch Extension (Agis panel, ARCHITECTURE.md §19d) — a DIFFERENT credential pair from the chat-bot
  // TWITCH_CLIENT_ID/SECRET above: these belong to the Extension itself (Twitch dev console → Extensions →
  // your extension → Extension Secrets), not to a Twitch application. Both optional; every /twitch-ext route
  // 503s when either is unset.
  TWITCH_EXTENSION_CLIENT_ID: z.string().optional(),
  TWITCH_EXTENSION_SECRET: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USER_AGENT: z.string().optional(),
  STEAM_API_KEY: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  INSTAGRAM_CLIENT_ID: z.string().optional(),
  INSTAGRAM_CLIENT_SECRET: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  TRANSLATE_PROVIDER: z.string().default('none'),
  DEEPL_API_KEY: z.string().optional(),
  LIBRETRANSLATE_URL: z.string().optional(),
  LIBRETRANSLATE_API_KEY: z.string().optional(),
  WEATHER_PROVIDER: z.string().default('none'),
  OPENWEATHERMAP_API_KEY: z.string().optional(),
  CAPTCHA_PROVIDER: z.string().default('none'),
  HCAPTCHA_SITE_KEY: z.string().optional(),
  HCAPTCHA_SECRET: z.string().optional(),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET: z.string().optional(),
  MEDIA_PROVIDER: z.string().default('none'),
  PUBLIC_WEBHOOK_BASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }
  return result.data;
}

loadEnv();

/** The process's validated environment configuration. Every key except NODE_ENV/LOG_LEVEL is optional. */
export const env: Env = parseEnv(process.env);

/** True when running with NODE_ENV=production. */
export const isProduction = env.NODE_ENV === 'production';

/**
 * Asserts that every named env key is set (and non-empty); throws a ConfigError listing all missing keys
 * with a hint to copy `.env.example`.
 */
export function requireEnv(...keys: (keyof Env)[]): void {
  const missing = keys.filter((key) => {
    const value = env[key];
    return value === undefined || value === '';
  });
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and fill in the missing values.`,
    );
  }
}

/** Splits a comma-separated env value (e.g. `env.BOT_OWNER_IDS`) into a trimmed, non-empty string array. */
export function listFromCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
