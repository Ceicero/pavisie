import { randomBytes } from 'node:crypto';

// Runs before any test file's own imports are evaluated, so `@pavisie/core`'s `env` singleton
// (computed at module-import time) picks these up. Values are disposable test-only secrets.
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? randomBytes(32).toString('base64');
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? randomBytes(32).toString('base64');
process.env.DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://localhost:3000';
process.env.API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001';
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? 'test-discord-client-id';
process.env.DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? 'test-discord-client-secret';
process.env.DISCORD_OAUTH_REDIRECT_URI =
  process.env.DISCORD_OAUTH_REDIRECT_URI ?? 'http://localhost:3001/auth/discord/callback';
process.env.TWITCH_EVENTSUB_SECRET = process.env.TWITCH_EVENTSUB_SECRET ?? 'twitch_test_secret';
process.env.GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? 'github_test_secret';
process.env.CAPTCHA_PROVIDER = process.env.CAPTCHA_PROVIDER ?? 'turnstile';
process.env.TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY ?? 'test-turnstile-site-key';
process.env.TURNSTILE_SECRET = process.env.TURNSTILE_SECRET ?? 'test-turnstile-secret';
