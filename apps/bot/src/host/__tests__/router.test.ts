import { describe, expect, it, vi } from 'vitest';
import { Cooldowns, MemoryRateLimiter, createPlatformEvents } from '@pavisie/core';
import {
  DEFAULT_GUILD_CONFIG,
  ServiceRegistry,
  type ComponentContext,
  type ComponentHandler,
  type GuildConfigData,
  type Plugin,
  type PluginContext,
  type PluginManifest,
  type PluginRegistry,
} from '@pavisie/plugins';
import type { PluginId } from '@pavisie/types';
import { routeInteraction } from '../router';
import type { LoadedHost } from '../loader';

const GUILD_ID = 'guild-1';
const OWNER_ID = 'owner-user-1';

function fakeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'utility' as PluginId,
    name: 'Utility',
    description: 'test plugin',
    category: 'utility',
    version: '0.1.0',
    defaultEnabled: true,
    alwaysEnabled: true,
    permissions: [],
    intents: [],
    requiredEnv: [],
    configSchema: undefined as unknown as PluginManifest['configSchema'],
    defaultConfig: {},
    ...overrides,
  };
}

function fakePlugin(manifest: PluginManifest, component?: ComponentHandler): Plugin {
  return {
    manifest,
    commands: [],
    components: component ? [component] : [],
  };
}

function fakeContext(): PluginContext {
  return {
    t: (key: string) => key,
    getConfig: async () => ({}),
  } as unknown as PluginContext;
}

function fakeGuildConfig(): GuildConfigData {
  return { guildId: GUILD_ID, ...DEFAULT_GUILD_CONFIG };
}

interface FakeHostOverrides {
  components?: LoadedHost['components'];
  commands?: LoadedHost['commands'];
  availability?: LoadedHost['availability'];
  contexts?: LoadedHost['contexts'];
}

function fakeHost(overrides: FakeHostOverrides = {}): LoadedHost {
  const pluginId: PluginId = 'utility';
  const contexts = overrides.contexts ?? new Map([[pluginId, fakeContext()]]);
  const availability = overrides.availability ?? new Map([[pluginId, { available: true }]]);

  return {
    registry: {} as unknown as PluginRegistry,
    configStore: {
      getGuildConfig: async () => fakeGuildConfig(),
      isEnabled: async () => true,
    } as unknown as LoadedHost['configStore'],
    services: new ServiceRegistry(),
    events: createPlatformEvents(),
    contexts,
    commands: overrides.commands ?? new Map(),
    components: overrides.components ?? new Map(),
    availability,
    botOwnerIds: [],
    cooldowns: new Cooldowns('memory'),
    globalRateLimiter: new MemoryRateLimiter(),
    queueCache: new Map(),
  };
}

function fakeMember(userId: string) {
  return {
    id: userId,
    roles: { cache: new Map(), highest: { position: 1 } },
    permissions: { bitfield: 0n },
    user: { bot: false },
  };
}

interface FakeButtonInteractionOptions {
  customId: string;
  userId?: string;
  inGuild?: boolean;
}

function fakeButtonInteraction(options: FakeButtonInteractionOptions) {
  const userId = options.userId ?? OWNER_ID;
  const inGuild = options.inGuild ?? true;

  return {
    customId: options.customId,
    isButton: () => true,
    isAnySelectMenu: () => false,
    isModalSubmit: () => false,
    isChatInputCommand: () => false,
    isContextMenuCommand: () => false,
    isAutocomplete: () => false,
    inCachedGuild: () => inGuild,
    locale: 'en-US',
    user: { id: userId },
    guildId: inGuild ? GUILD_ID : null,
    guild: { ownerId: 'guild-owner' },
    member: fakeMember(userId),
    channel: null,
    deferred: false,
    replied: false,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
}

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as import('pino').Logger;

describe('routeInteraction — component (custom-id) routing', () => {
  it('replies with an error and does nothing else when no handler is registered for the custom id', async () => {
    const interaction = fakeButtonInteraction({ customId: 'utility:missing-action:' + OWNER_ID });
    const host = fakeHost({ components: new Map() });

    await routeInteraction(interaction as never, host, logger);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });

  it('rejects when the interaction kind does not match the registered handler kind', async () => {
    const handler: ComponentHandler = {
      action: 'do-thing',
      kind: 'select',
      handler: vi.fn(async () => undefined),
    };
    const plugin = fakePlugin(fakeManifest(), handler);
    const host = fakeHost({ components: new Map([['utility:do-thing', { plugin, handler }]]) });
    const interaction = fakeButtonInteraction({ customId: 'utility:do-thing:' + OWNER_ID }); // isButton() -> true, but handler.kind is 'select'

    await routeInteraction(interaction as never, host, logger);

    expect(handler.handler).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-owner when the handler is ownerOnly (default true), without invoking the handler', async () => {
    const handler: ComponentHandler = {
      action: 'do-thing',
      kind: 'button',
      handler: vi.fn(async () => undefined),
    };
    const plugin = fakePlugin(fakeManifest(), handler);
    const host = fakeHost({ components: new Map([['utility:do-thing', { plugin, handler }]]) });
    const interaction = fakeButtonInteraction({
      customId: `utility:do-thing:${OWNER_ID}`,
      userId: 'someone-else',
    });

    await routeInteraction(interaction as never, host, logger);

    expect(handler.handler).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });

  it('routes to the correct handler and passes parsed custom-id args when the owner clicks it', async () => {
    const handlerFn = vi.fn(async (_c: ComponentContext) => undefined);
    const handler: ComponentHandler = { action: 'do-thing', kind: 'button', handler: handlerFn };
    const plugin = fakePlugin(fakeManifest(), handler);
    const host = fakeHost({ components: new Map([['utility:do-thing', { plugin, handler }]]) });
    const interaction = fakeButtonInteraction({
      customId: `utility:do-thing:${OWNER_ID}:extra-arg`,
      userId: OWNER_ID,
    });

    await routeInteraction(interaction as never, host, logger);

    expect(handlerFn).toHaveBeenCalledTimes(1);
    const componentContext = handlerFn.mock.calls[0][0];
    expect(componentContext.args).toEqual([OWNER_ID, 'extra-arg']);
    expect(componentContext.guildId).toBe(GUILD_ID);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('does not route to a different plugin/action than the one encoded in the custom id', async () => {
    const rightHandlerFn = vi.fn(async () => undefined);
    const wrongHandlerFn = vi.fn(async () => undefined);
    const rightHandler: ComponentHandler = {
      action: 'right-action',
      kind: 'button',
      handler: rightHandlerFn,
    };
    const wrongHandler: ComponentHandler = {
      action: 'wrong-action',
      kind: 'button',
      handler: wrongHandlerFn,
    };
    const plugin = fakePlugin(fakeManifest());

    const host = fakeHost({
      components: new Map([
        ['utility:right-action', { plugin, handler: rightHandler }],
        ['utility:wrong-action', { plugin, handler: wrongHandler }],
      ]),
    });
    const interaction = fakeButtonInteraction({ customId: `utility:right-action:${OWNER_ID}` });

    await routeInteraction(interaction as never, host, logger);

    expect(rightHandlerFn).toHaveBeenCalledTimes(1);
    expect(wrongHandlerFn).not.toHaveBeenCalled();
  });

  it('replies with a guild-only error when the interaction is not in a cached guild', async () => {
    const handlerFn = vi.fn(async () => undefined);
    const handler: ComponentHandler = { action: 'do-thing', kind: 'button', handler: handlerFn };
    const plugin = fakePlugin(fakeManifest(), handler);
    const host = fakeHost({ components: new Map([['utility:do-thing', { plugin, handler }]]) });
    const interaction = fakeButtonInteraction({ customId: `utility:do-thing:${OWNER_ID}`, inGuild: false });

    await routeInteraction(interaction as never, host, logger);

    expect(handlerFn).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });
});

describe('routeInteraction — unknown slash command', () => {
  it('replies with an error and does not throw when the command name is not registered', async () => {
    const interaction = {
      isButton: () => false,
      isAnySelectMenu: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      isContextMenuCommand: () => false,
      isAutocomplete: () => false,
      commandName: 'nonexistent',
      inCachedGuild: () => true,
      locale: 'en-US',
      user: { id: OWNER_ID },
      guildId: GUILD_ID,
      guild: { ownerId: 'guild-owner' },
      member: fakeMember(OWNER_ID),
      channel: null,
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    const host = fakeHost();

    await expect(routeInteraction(interaction as never, host, logger)).resolves.toBeUndefined();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
  });
});
