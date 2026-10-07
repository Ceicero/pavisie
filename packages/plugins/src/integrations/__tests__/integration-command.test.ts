import RedisMock from 'ioredis-mock';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { createTestContext } from '../../sdk/testing';
import type { CommandContext, PluginContext } from '../../sdk';
import en from '../locales/en.json';

let integrationCommand: typeof import('../commands/integration').command;
let createAlertConnection: typeof import('../connections').createAlertConnection;
let resetTwitchEventSubState: typeof import('../providers/twitch').resetTwitchEventSubState;

beforeAll(async () => {
  ({ command: integrationCommand } = await import('../commands/integration'));
  ({ createAlertConnection } = await import('../connections'));
  ({ resetTwitchEventSubState } = await import('../providers/twitch'));
});

const originalFetch = globalThis.fetch;
const GUILD_ID = 'guild-1';
const CHANNEL_ID = '123456789012345678';

beforeEach(async () => {
  await new RedisMock().flushall();
  resetTwitchEventSubState();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Looks a dotted key up in the plugin's real `en.json` with `{var}` interpolation. */
function realT(key: string, vars?: Record<string, string | number>): string {
  let node: unknown = en;
  for (const part of key.split('.')) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }
  if (typeof node !== 'string') return key;
  let out = node;
  for (const [k, v] of Object.entries(vars ?? {})) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    TWITCH_CLIENT_ID: 'client-id',
    TWITCH_CLIENT_SECRET: 'client-secret',
    TWITCH_EVENTSUB_SECRET: 'eventsub-secret',
    PUBLIC_WEBHOOK_BASE_URL: 'https://api.pavisie.com',
    DASHBOARD_URL: 'https://pavisie.com',
    ...overrides,
  } as unknown as PluginContext['env'];
}

/** Helix with one real user (`somestreamer`, id `b-1`) and an empty subscription list; records every request. */
function installHelix() {
  const requests: { method: string; url: string }[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    requests.push({ method, url: url.toString() });
    if (url.host === 'id.twitch.tv') {
      return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
    }
    if (url.pathname === '/helix/users') {
      const login = url.searchParams.get('login');
      const data =
        login === 'somestreamer' ? [{ id: 'b-1', login: 'somestreamer', display_name: 'SomeStreamer' }] : [];
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    if (url.pathname === '/helix/eventsub/subscriptions') {
      return method === 'POST'
        ? new Response(JSON.stringify({ data: [{ id: 'sub-1', status: 'webhook_callback_verification_pending' }] }), {
            status: 202,
          })
        : new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 });
    }
    throw new Error(`unexpected ${method} ${url.toString()}`);
  }) as unknown as typeof fetch;
  return requests;
}

interface ReplyPayload {
  embeds?: EmbedBuilder[];
  ephemeral?: boolean;
}

function buildContext(opts: {
  sub: string;
  group?: string | null;
  strings?: Record<string, string | null>;
  withChannel?: boolean;
  env?: PluginContext['env'];
}) {
  const replies: ReplyPayload[] = [];
  const created: Record<string, unknown>[] = [];
  const interaction = {
    user: { id: 'admin-1' },
    guild: { id: GUILD_ID },
    options: {
      getSubcommandGroup: () => opts.group ?? null,
      getSubcommand: () => opts.sub,
      getString: (name: string, required?: boolean) => {
        const value = (opts.strings ?? {})[name] ?? null;
        if (required && value === null) throw new Error(`missing required string option: ${name}`);
        return value;
      },
      getChannel: () => (opts.withChannel === false ? null : { id: CHANNEL_ID }),
      getRole: () => null,
    },
    reply: vi.fn(async (payload: ReplyPayload) => {
      replies.push(payload);
    }),
  };
  const { ctx } = createTestContext({
    overrides: { env: opts.env ?? makeEnv() },
    prismaOverrides: {
      integrationConnection: {
        create: async (...args: unknown[]) => {
          const data = (args[0] as { data: Record<string, unknown> }).data;
          created.push(data);
          return { id: 'conn-new', deletedAt: null, ...data };
        },
      },
    },
  });
  const c: CommandContext = {
    interaction: interaction as unknown as ChatInputCommandInteraction<'cached'>,
    ctx,
    guildId: GUILD_ID,
    staffLevel: 'admin',
    locale: 'en-US' as never,
    t: realT,
    config: async <T>() => ({}) as T,
  };
  return { c, replies, created, ctx };
}

const description = (replies: ReplyPayload[]) => replies[0]?.embeds?.[0]?.data.description ?? '';

describe('/integration connect provider:twitch', () => {
  it('creates the alert directly — no "connect from the dashboard / OAuth" dead end', async () => {
    installHelix();
    const { c, replies, created } = buildContext({
      sub: 'connect',
      strings: { provider: 'twitch', target: 'SomeStreamer' },
    });

    await integrationCommand.execute(c);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      guildId: GUILD_ID,
      provider: 'TWITCH',
      status: 'CONNECTED',
      label: 'somestreamer',
      externalAccountId: 'b-1',
      externalAccountName: 'SomeStreamer',
      config: { target: 'somestreamer', channelId: CHANNEL_ID },
    });
    expect(description(replies)).toContain('Connected **Twitch**');
    expect(description(replies)).toContain('somestreamer');
    expect(description(replies)).not.toContain('OAuth');
  });

  it('answers "Twitch user X not found." and creates nothing for an unknown login', async () => {
    installHelix();
    const { c, replies, created } = buildContext({
      sub: 'connect',
      strings: { provider: 'twitch', target: 'ghostuser' },
    });

    await integrationCommand.execute(c);

    expect(created).toHaveLength(0);
    expect(description(replies)).toContain('Twitch user "ghostuser" not found.');
  });

  it('rejects a malformed login before calling Twitch at all', async () => {
    const requests = installHelix();
    const { c, replies, created } = buildContext({
      sub: 'connect',
      strings: { provider: 'twitch', target: 'not a login!' },
    });

    await integrationCommand.execute(c);

    expect(created).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(description(replies)).toContain('not a valid Twitch username');
  });

  it('still asks for target and channel when either is missing', async () => {
    installHelix();
    const { c, replies, created } = buildContext({
      sub: 'connect',
      strings: { provider: 'twitch', target: 'somestreamer' },
      withChannel: false,
    });

    await integrationCommand.execute(c);

    expect(created).toHaveLength(0);
    expect(description(replies)).toContain('`target` and `channel`');
  });

  it('creates the connection (in ERROR with the missing env named) when the operator has not set Twitch up', async () => {
    const requests = installHelix();
    const { c, replies, created } = buildContext({
      sub: 'connect',
      strings: { provider: 'twitch', target: 'somestreamer' },
      env: makeEnv({ TWITCH_CLIENT_ID: undefined, TWITCH_CLIENT_SECRET: undefined }),
    });

    await integrationCommand.execute(c);

    expect(requests).toHaveLength(0); // no Twitch calls without credentials
    expect(created[0]).toMatchObject({ status: 'ERROR' });
    expect(description(replies)).toContain('TWITCH_CLIENT_ID');
  });

  it('still points genuinely-OAuth providers (Instagram) at the dashboard', async () => {
    installHelix();
    const { c, replies, created } = buildContext({ sub: 'connect', strings: { provider: 'instagram' } });

    await integrationCommand.execute(c);

    expect(created).toHaveLength(0);
    expect(description(replies)).toContain('OAuth has to start from your signed-in dashboard session');
    expect(description(replies)).toContain('https://pavisie.com/dashboard/guild-1/integrations');
  });
});

describe('/integration alerts add provider:twitch', () => {
  it('keeps working and stores the normalized login', async () => {
    installHelix();
    const { c, replies, created } = buildContext({
      sub: 'add',
      group: 'alerts',
      strings: { provider: 'twitch', target: '@SomeStreamer' },
    });

    await integrationCommand.execute(c);

    expect(created[0]).toMatchObject({ provider: 'TWITCH', config: { target: 'somestreamer' } });
    expect(description(replies)).toContain('Watching **somestreamer** on twitch');
  });

  it('reports an unknown user as an error reply', async () => {
    installHelix();
    const { c, replies, created } = buildContext({
      sub: 'add',
      group: 'alerts',
      strings: { provider: 'twitch', target: 'ghostuser' },
    });

    await integrationCommand.execute(c);

    expect(created).toHaveLength(0);
    expect(description(replies)).toContain('Twitch user "ghostuser" not found.');
  });
});

describe('createAlertConnection (twitch)', () => {
  it('sets up the EventSub subscription right away for a valid Twitch login', async () => {
    const requests = installHelix();
    const { ctx } = buildContext({ sub: 'connect' });

    await createAlertConnection(ctx, GUILD_ID, 'admin-1', 'bot', {
      provider: 'twitch',
      target: 'somestreamer',
      channelId: CHANNEL_ID,
    });

    expect(requests.some((r) => r.method === 'POST' && r.url.includes('/eventsub/subscriptions'))).toBe(true);
  });

  it('does not block creating an alert when Twitch itself is unreachable for the check', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const created: Record<string, unknown>[] = [];
    const { ctx } = createTestContext({
      overrides: { env: makeEnv() },
      prismaOverrides: {
        integrationConnection: {
          create: async (...args: unknown[]) => {
            const data = (args[0] as { data: Record<string, unknown> }).data;
            created.push(data);
            return { id: 'conn-new', deletedAt: null, ...data };
          },
        },
      },
    });

    await createAlertConnection(ctx, GUILD_ID, 'admin-1', 'bot', {
      provider: 'twitch',
      target: 'somestreamer',
      channelId: CHANNEL_ID,
    });

    expect(created).toHaveLength(1);
    expect(created[0]).not.toHaveProperty('externalAccountId');
  });
});
