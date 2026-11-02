import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  assertServiceEnv,
  checkServiceEnv,
  formatEnvProblems,
  requiredEnvNames,
  type ServiceName,
} from '../src/service-env';
import { decryptSecret, encryptSecret } from '../src/crypto/encryption';

const KEY = randomBytes(32).toString('base64');

const validBot = {
  DISCORD_TOKEN: 'bot-token-value',
  DISCORD_CLIENT_ID: '123456789012345678',
  DATABASE_URL: 'postgresql://user:pw@db.internal:5432/pavisie',
  REDIS_URL: 'redis://default:pw@cache.internal:6379',
};

const validApi = {
  DATABASE_URL: 'postgresql://user:pw@db.internal:5432/pavisie',
  REDIS_URL: 'rediss://default:pw@cache.internal:6379',
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_CLIENT_SECRET: 'client-secret-value',
  SESSION_SECRET: 'session-secret-value',
  ENCRYPTION_KEY: KEY,
  DISCORD_OAUTH_REDIRECT_URI: 'https://api.pavisie.com/auth/discord/callback',
  DASHBOARD_URL: 'https://pavisie.com',
};

const ASSERT_SENTINEL = 'ASSERT-SENTINEL-1b2c3d';

const names = (problems: { name: string }[]) => problems.map((p) => p.name).sort();

describe('checkServiceEnv: valid environments', () => {
  it('accepts a minimal bot env', () => {
    expect(checkServiceEnv('bot', validBot)).toEqual([]);
  });

  it('accepts a minimal api env', () => {
    expect(checkServiceEnv('api', validApi)).toEqual([]);
  });

  it('accepts an empty env for dashboard and web (nothing is required)', () => {
    expect(checkServiceEnv('dashboard', {})).toEqual([]);
    expect(checkServiceEnv('web', {})).toEqual([]);
  });

  it('treats blank and whitespace-only optional values as unset', () => {
    const blanks = {
      ...validApi,
      API_PORT: '',
      KOFI_URL: '   ',
      ENCRYPTION_KEY_PREVIOUS: '',
      TRUST_PROXY: '',
    };
    expect(checkServiceEnv('api', blanks)).toEqual([]);
    expect(
      checkServiceEnv('web', { NEXT_PUBLIC_DISCORD_CLIENT_ID: '', NEXT_PUBLIC_SUPPORT_SERVER_URL: '' }),
    ).toEqual([]);
  });

  it('accepts well-formed optional values', () => {
    expect(
      checkServiceEnv('api', {
        ...validApi,
        API_PORT: '3001',
        API_BASE_URL: 'https://api.pavisie.com',
        WEB_URL: 'https://pavisie.com',
        KOFI_URL: 'https://ko-fi.com/someone',
        PUBLIC_WEBHOOK_BASE_URL: 'https://api.pavisie.com',
        SESSION_COOKIE_SAMESITE: 'none',
        TRUST_PROXY: '1',
        ENCRYPTION_KEY_PREVIOUS: randomBytes(32).toString('hex'),
      }),
    ).toEqual([]);
    expect(
      checkServiceEnv('bot', {
        ...validBot,
        BOT_HEALTH_PORT: '3002',
        REGISTER_COMMANDS_ON_BOOT: 'guild',
        ENCRYPTION_KEY: KEY,
        WEB_URL: 'https://pavisie.com',
      }),
    ).toEqual([]);
    expect(
      checkServiceEnv('web', {
        NEXT_PUBLIC_API_URL: 'http://localhost:3001',
        NEXT_PUBLIC_DISCORD_CLIENT_ID: '0',
        NEXT_PUBLIC_SUPPORT_SERVER_URL: 'https://discord.gg/abcdef',
      }),
    ).toEqual([]);
  });
});

describe('checkServiceEnv: missing variables', () => {
  it('lists every missing bot variable by name', () => {
    const problems = checkServiceEnv('bot', {});
    expect(names(problems)).toEqual(['DATABASE_URL', 'DISCORD_CLIENT_ID', 'DISCORD_TOKEN', 'REDIS_URL']);
    expect(problems.every((p) => p.reason === 'missing')).toBe(true);
  });

  it('lists every missing api variable by name', () => {
    expect(names(checkServiceEnv('api', {}))).toEqual(
      [
        'DASHBOARD_URL',
        'DATABASE_URL',
        'DISCORD_CLIENT_ID',
        'DISCORD_CLIENT_SECRET',
        'DISCORD_OAUTH_REDIRECT_URI',
        'ENCRYPTION_KEY',
        'REDIS_URL',
        'SESSION_SECRET',
      ].sort(),
    );
  });

  it('treats blank required values as missing', () => {
    expect(checkServiceEnv('bot', { ...validBot, DISCORD_TOKEN: '   ' })).toEqual([
      { name: 'DISCORD_TOKEN', reason: 'missing' },
    ]);
  });

  it('only reports what is actually absent', () => {
    const { REDIS_URL: _omit, ...rest } = validBot;
    expect(checkServiceEnv('bot', rest)).toEqual([{ name: 'REDIS_URL', reason: 'missing' }]);
  });
});

describe('checkServiceEnv: invalid variables', () => {
  it('flags malformed values with a reason', () => {
    const problems = checkServiceEnv('api', {
      ...validApi,
      DATABASE_URL: 'mysql://nope',
      REDIS_URL: 'not a url',
      DASHBOARD_URL: 'pavisie.com',
      API_PORT: 'abc',
      SESSION_COOKIE_SAMESITE: 'strict',
      TRUST_PROXY: 'yes',
      ENCRYPTION_KEY: 'too-short',
      KOFI_URL: 'ko-fi.com/me',
    });
    expect(names(problems)).toEqual(
      [
        'API_PORT',
        'DASHBOARD_URL',
        'DATABASE_URL',
        'ENCRYPTION_KEY',
        'KOFI_URL',
        'REDIS_URL',
        'SESSION_COOKIE_SAMESITE',
        'TRUST_PROXY',
      ].sort(),
    );
    const byName = Object.fromEntries(problems.map((p) => [p.name, p.reason]));
    expect(byName.API_PORT).toMatch(/integer between 1 and 65535/);
    expect(byName.DATABASE_URL).toMatch(/postgres/);
    expect(byName.REDIS_URL).toMatch(/redis/);
    expect(byName.SESSION_COOKIE_SAMESITE).toBe('must be one of: lax, none');
    expect(byName.ENCRYPTION_KEY).toMatch(/32 bytes/);
  });

  it.each(['0', '65536', '-1', '30.5', '3001abc'])('rejects API_PORT=%s', (value) => {
    expect(names(checkServiceEnv('api', { ...validApi, API_PORT: value }))).toEqual(['API_PORT']);
  });

  it('validates BOT_HEALTH_PORT and REGISTER_COMMANDS_ON_BOOT on the bot', () => {
    expect(
      names(
        checkServiceEnv('bot', { ...validBot, BOT_HEALTH_PORT: 'x', REGISTER_COMMANDS_ON_BOOT: 'always' }),
      ),
    ).toEqual(['BOT_HEALTH_PORT', 'REGISTER_COMMANDS_ON_BOOT']);
  });

  it('rejects a non-numeric DISCORD_CLIENT_ID (e.g. a secret pasted into the wrong field)', () => {
    expect(names(checkServiceEnv('bot', { ...validBot, DISCORD_CLIENT_ID: 'abc.def' }))).toEqual([
      'DISCORD_CLIENT_ID',
    ]);
  });

  it('validates optional URLs on the Next apps', () => {
    expect(
      names(checkServiceEnv('web', { NEXT_PUBLIC_API_URL: 'api.pavisie.com', WEB_URL: 'nope' })),
    ).toEqual(['NEXT_PUBLIC_API_URL', 'WEB_URL']);
    expect(names(checkServiceEnv('dashboard', { WEB_URL: 'ftp://x' }))).toEqual(['WEB_URL']);
  });

  it('reports each variable once', () => {
    const problems = checkServiceEnv('api', { ...validApi, ENCRYPTION_KEY: '!!' });
    expect(problems.filter((p) => p.name === 'ENCRYPTION_KEY')).toHaveLength(1);
  });
});

describe('ENCRYPTION_KEY validation agrees with crypto/encryption', () => {
  it.each([
    ['base64 of 32 bytes', randomBytes(32).toString('base64'), true],
    ['lowercase hex of 32 bytes', randomBytes(32).toString('hex'), true],
    ['base64 of 16 bytes', randomBytes(16).toString('base64'), false],
    ['base64 of 33 bytes', randomBytes(33).toString('base64'), false],
    ['junk', 'hello', false],
  ])('%s', (_label, key, ok) => {
    const problems = checkServiceEnv('api', { ...validApi, ENCRYPTION_KEY: key });
    expect(problems.length === 0).toBe(ok);
    if (ok) {
      expect(decryptSecret(encryptSecret('x', key), key)).toBe('x');
    } else {
      expect(() => encryptSecret('x', key)).toThrow();
    }
  });
});

describe('values never appear in output', () => {
  // Distinctive sentinel: if any value survives into a message, a plain substring check finds it.
  const SECRET = 'SENTINEL-s3cr3t-7f3a9c';
  const poisoned: Record<ServiceName, Record<string, string>> = {
    bot: {
      DISCORD_TOKEN: SECRET,
      DISCORD_CLIENT_ID: `${SECRET}-id`,
      DATABASE_URL: `mysql://admin:${SECRET}@host/db`,
      REDIS_URL: `http://admin:${SECRET}@host`,
      ENCRYPTION_KEY: `${SECRET}-key`,
      ENCRYPTION_KEY_PREVIOUS: `${SECRET}-prev`,
      BOT_HEALTH_PORT: `${SECRET}-port`,
      REGISTER_COMMANDS_ON_BOOT: `${SECRET}-mode`,
      WEB_URL: `${SECRET}-web`,
    },
    api: {
      DATABASE_URL: `mysql://admin:${SECRET}@host/db`,
      REDIS_URL: `${SECRET}-redis`,
      DISCORD_CLIENT_ID: `${SECRET}-id`,
      DISCORD_CLIENT_SECRET: SECRET,
      SESSION_SECRET: SECRET,
      ENCRYPTION_KEY: `${SECRET}-key`,
      ENCRYPTION_KEY_PREVIOUS: `${SECRET}-prev`,
      DISCORD_OAUTH_REDIRECT_URI: `${SECRET}-uri`,
      DASHBOARD_URL: `${SECRET}-dash`,
      API_PORT: `${SECRET}-port`,
      API_BASE_URL: `${SECRET}-base`,
      WEB_URL: `${SECRET}-web`,
      PUBLIC_WEBHOOK_BASE_URL: `${SECRET}-hook`,
      KOFI_URL: `${SECRET}-kofi`,
      SESSION_COOKIE_SAMESITE: `${SECRET}-samesite`,
      TRUST_PROXY: `${SECRET}-proxy`,
    },
    dashboard: { NEXT_PUBLIC_API_URL: `${SECRET}-api`, WEB_URL: `${SECRET}-web` },
    web: {
      NEXT_PUBLIC_API_URL: `${SECRET}-api`,
      NEXT_PUBLIC_SITE_URL: `${SECRET}-site`,
      NEXT_PUBLIC_SUPPORT_SERVER_URL: `${SECRET}-support`,
      NEXT_PUBLIC_DISCORD_CLIENT_ID: `${SECRET}-id`,
      WEB_URL: `${SECRET}-web`,
    },
  };
  // Required secrets with no format rule: set, so they pass and are not reported at all.
  const unformatted = new Set(['DISCORD_TOKEN', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET']);

  it.each(['bot', 'api', 'dashboard', 'web'] as const)(
    '%s: invalid values are named but never echoed',
    (service) => {
      const problems = checkServiceEnv(service, poisoned[service]);
      expect(problems.length).toBeGreaterThan(0);
      const message = formatEnvProblems(service, problems);
      expect(message).not.toContain(SECRET);
      expect(JSON.stringify(problems)).not.toContain(SECRET);
      for (const [name, value] of Object.entries(poisoned[service])) {
        expect(message).not.toContain(value);
        if (!unformatted.has(name)) expect(message).toContain(`${name}:`);
      }
    },
  );

  it('does not print the values of variables that pass validation either', () => {
    const message = formatEnvProblems(
      'api',
      checkServiceEnv('api', { ...validApi, SESSION_SECRET: SECRET, DATABASE_URL: 'bad' }),
    );
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain('client-secret-value');
  });
});

describe('formatEnvProblems / assertServiceEnv', () => {
  it('names the service, every variable, and where to look', () => {
    const message = formatEnvProblems('api', [
      { name: 'DATABASE_URL', reason: 'missing' },
      { name: 'API_PORT', reason: 'must be an integer between 1 and 65535' },
    ]);
    expect(message).toContain('[pavisie:api]');
    expect(message).toContain('DATABASE_URL: missing');
    expect(message).toContain('API_PORT: must be an integer between 1 and 65535');
    expect(message).toContain('.env.example');
    expect(message).toContain('infra/DEPLOYMENT.md');
    expect(message).toContain('2 environment variables are');
  });

  it('prints once and exits with code 1 on failure', () => {
    const print = vi.fn();
    const exit = vi.fn((): never => {
      throw new Error('exit called');
    });
    expect(() => assertServiceEnv('bot', { DISCORD_TOKEN: ASSERT_SENTINEL }, { print, exit })).toThrow(
      'exit called',
    );
    expect(print).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    const printed = String(print.mock.calls[0]?.[0]);
    expect(printed).toContain('[pavisie:bot]');
    expect(printed).toContain('DATABASE_URL: missing');
    expect(printed).not.toContain(ASSERT_SENTINEL);
  });

  it('does nothing when the environment is valid', () => {
    const print = vi.fn();
    const exit = vi.fn((): never => {
      throw new Error('exit called');
    });
    expect(() => assertServiceEnv('bot', validBot, { print, exit })).not.toThrow();
    expect(print).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('defaults to process.env, console.error and process.exit(1)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    const saved = { ...process.env };
    try {
      for (const name of requiredEnvNames('bot')) delete process.env[name];
      assertServiceEnv('bot');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      process.env = saved;
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe('per-service differences', () => {
  it('requires different variables per service', () => {
    expect(requiredEnvNames('bot').sort()).toEqual([
      'DATABASE_URL',
      'DISCORD_CLIENT_ID',
      'DISCORD_TOKEN',
      'REDIS_URL',
    ]);
    expect(requiredEnvNames('api')).toContain('SESSION_SECRET');
    expect(requiredEnvNames('api')).toContain('ENCRYPTION_KEY');
    expect(requiredEnvNames('api')).not.toContain('DISCORD_TOKEN');
    expect(requiredEnvNames('dashboard')).toEqual([]);
    expect(requiredEnvNames('web')).toEqual([]);
  });

  it('the api does not need a bot token; the bot does not need the OAuth secret or session secret', () => {
    expect(names(checkServiceEnv('api', {}))).not.toContain('DISCORD_TOKEN');
    expect(names(checkServiceEnv('bot', {}))).not.toContain('SESSION_SECRET');
    expect(names(checkServiceEnv('bot', {}))).not.toContain('DISCORD_CLIENT_SECRET');
  });

  it('an env valid for the bot is not automatically valid for the api', () => {
    expect(names(checkServiceEnv('api', validBot))).toEqual(
      [
        'DASHBOARD_URL',
        'DISCORD_CLIENT_SECRET',
        'DISCORD_OAUTH_REDIRECT_URI',
        'ENCRYPTION_KEY',
        'SESSION_SECRET',
      ].sort(),
    );
  });
});
