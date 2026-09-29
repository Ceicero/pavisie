// In-memory Prisma fakes for the creator dashboard tests (channel / command / timer / bot identity models) — the
// same recording-`Proxy`-over-a-`Map` shape `twitch-chat.test.ts` uses for the guild routes, trimmed to what
// `/creator/*` touches. `matchWhere` understands Prisma's compound-`@@unique` where-shape
// (`{ channelId_name: { channelId, name } }`) by recursing into the wrapper object's own keys, which happen to be
// real columns on the row.
import type { PrismaStubOverrides } from '@pavisie/plugins/sdk/testing';

/* eslint-disable @typescript-eslint/no-explicit-any -- test fakes: args mirror Prisma's generated types loosely */

function matchWhere(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, val]) => {
    if (val && typeof val === 'object' && !(val instanceof Date)) {
      if ('in' in (val as Record<string, unknown>)) {
        return (val as { in: unknown[] }).in.includes(row[key]);
      }
      return matchWhere(row, val);
    }
    return row[key] === val;
  });
}

function makeModel(store: Map<string, any>, idPrefix: string, applyDefaults: (partial: any) => any) {
  let n = 1;
  return {
    findMany: async (args: any) => {
      let list = [...store.values()].filter((r) => matchWhere(r, args?.where));
      if (args?.orderBy) {
        const [field, dir] = Object.entries(args.orderBy)[0] as [string, string];
        list = [...list].sort((a, b) => {
          const av = a[field] instanceof Date ? a[field].getTime() : a[field];
          const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
          const cmp = av === bv ? 0 : av < bv ? -1 : 1;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      return list;
    },
    findFirst: async (args: any) => [...store.values()].find((r) => matchWhere(r, args?.where)) ?? null,
    findUnique: async (args: any) => [...store.values()].find((r) => matchWhere(r, args?.where)) ?? null,
    count: async (args: any) => [...store.values()].filter((r) => matchWhere(r, args?.where)).length,
    create: async (args: any) => {
      const id = `${idPrefix}${n++}`;
      const row = applyDefaults({ id, ...args.data });
      store.set(id, row);
      return row;
    },
    update: async (args: any) => {
      const existing = store.get(args.where.id as string)!;
      const updated = { ...existing, ...args.data };
      store.set(existing.id, updated);
      return updated;
    },
    delete: async (args: any) => {
      const existing = store.get(args.where.id as string)!;
      store.delete(existing.id);
      return existing;
    },
    updateMany: async (args: any) => {
      const hit = [...store.values()].filter((r) => matchWhere(r, args?.where));
      for (const r of hit) store.set(r.id, { ...r, ...args.data });
      return { count: hit.length };
    },
    deleteMany: async (args: any) => {
      const doomed = [...store.entries()].filter(([, r]) => matchWhere(r, args?.where));
      for (const [id] of doomed) store.delete(id);
      return { count: doomed.length };
    },
    upsert: async (args: any) => {
      const found = [...store.values()].find((r) => matchWhere(r, args.where));
      if (found) {
        const updated = { ...found, ...args.update };
        store.set(found.id, updated);
        return updated;
      }
      const id = `${idPrefix}${n++}`;
      const row = applyDefaults({ ...args.create, id });
      store.set(id, row);
      return row;
    },
  };
}

export function channelDefaults(partial: any) {
  return {
    guildId: null,
    enabled: true,
    status: 'PENDING',
    lastError: null,
    lastConnectedAt: null,
    commandPrefix: '!',
    connectionId: null,
    overlayTokenEnc: null,
    ttsOpenAiKeyEnc: null,
    rewardsEnabled: false,
    bridgeDiscordChannelId: null,
    bridgeDiscordToTwitch: false,
    bridgeTwitchToDiscord: false,
    bridgeWebhookId: null,
    bridgeWebhookTokenEnc: null,
    bridgeLastError: null,
    discordLinkedBy: null,
    discordLinkedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

function commandDefaults(partial: any) {
  return {
    guildId: null,
    cooldownSeconds: 5,
    minLevel: 'EVERYONE',
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

function timerDefaults(partial: any) {
  return { guildId: null, enabled: true, lastFiredAt: null, createdAt: new Date(), updatedAt: new Date(), ...partial };
}

function rewardDefaults(partial: any) {
  return {
    guildId: null,
    rewardId: null,
    enabled: true,
    volume: 80,
    soundUrl: null,
    ttsTemplate: null,
    chatTemplate: null,
    discordChannelId: null,
    discordTemplate: null,
    cooldownSeconds: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

function broadcasterTokenDefaults(partial: any) {
  return {
    refreshTokenEnc: null,
    scopes: [],
    expiresAt: null,
    rotatedAt: null,
    status: 'CONNECTED',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

function botIdentityDefaults(partial: any) {
  return { scopes: [], lastError: null, status: 'CONNECTED', createdAt: new Date(), updatedAt: new Date(), ...partial };
}

/** Stores + Prisma overrides for everything the creator routes and the reused Twitch callback touch. */
export function creatorFixture() {
  const channels = new Map<string, any>();
  const commands = new Map<string, any>();
  const timers = new Map<string, any>();
  const botIdentities = new Map<string, any>();
  const connections = new Map<string, any>();
  const oauthTokens = new Map<string, any>();
  const rewards = new Map<string, any>();
  const broadcasterTokens = new Map<string, any>();
  // Discord side (phase 3): the bot's Guild table, per-guild plugin enablement and the guild audit log.
  const guilds = new Map<string, any>();
  const pluginStates = new Map<string, any>();
  const auditLogs = new Map<string, any>();

  const overrides: PrismaStubOverrides = {
    twitchChatChannel: makeModel(channels, 'chan', channelDefaults),
    twitchChatCommand: makeModel(commands, 'cmd', commandDefaults),
    twitchChatTimer: makeModel(timers, 'timer', timerDefaults),
    twitchBotIdentity: makeModel(botIdentities, 'bot', botIdentityDefaults),
    integrationConnection: makeModel(connections, 'conn', (p) => ({ status: 'PENDING', config: {}, ...p })),
    oAuthToken: makeModel(oauthTokens, 'token', (p) => p),
    twitchChatReward: makeModel(rewards, 'reward', rewardDefaults),
    twitchBroadcasterToken: makeModel(broadcasterTokens, 'btok', broadcasterTokenDefaults),
    guild: makeModel(guilds, 'guild', (p) => ({ botPresent: true, iconHash: null, ...p })),
    pluginState: {
      ...makeModel(pluginStates, 'ps', (p) => p),
      // `GuildConfigStore` addresses the row by the compound `guildId_pluginId` key.
      findUnique: async (args: any) => {
        const k = args.where.guildId_pluginId;
        return [...pluginStates.values()].find((r) => r.guildId === k.guildId && r.pluginId === k.pluginId) ?? null;
      },
      upsert: async (args: any) => {
        const k = args.where.guildId_pluginId;
        const found = [...pluginStates.values()].find((r) => r.guildId === k.guildId && r.pluginId === k.pluginId);
        const id = found?.id ?? `ps${pluginStates.size + 1}`;
        const row = { ...(found ?? args.create), ...(found ? args.update : {}), id };
        pluginStates.set(id, row);
        return row;
      },
    },
    auditLog: makeModel(auditLogs, 'audit', (p) => p),
  };

  return {
    channels,
    commands,
    timers,
    botIdentities,
    connections,
    oauthTokens,
    rewards,
    broadcasterTokens,
    guilds,
    pluginStates,
    auditLogs,
    overrides,
  };
}

export function seedChannel(
  fixture: ReturnType<typeof creatorFixture>,
  partial: { id: string; broadcasterUserId: string; guildId?: string | null; [key: string]: unknown },
): any {
  const row = channelDefaults({ broadcasterLogin: `login-${partial.broadcasterUserId}`, createdBy: 'seed', ...partial });
  fixture.channels.set(row.id, row);
  return row;
}

export function seedReward(
  fixture: ReturnType<typeof creatorFixture>,
  partial: { id: string; channelId: string; rewardTitle: string; action: string; [key: string]: unknown },
): any {
  const row = rewardDefaults({ createdBy: 'seed', ...partial });
  fixture.rewards.set(row.id, row);
  return row;
}

export function seedBroadcasterToken(
  fixture: ReturnType<typeof creatorFixture>,
  partial: { id: string; channelId: string; [key: string]: unknown },
): any {
  const row = broadcasterTokenDefaults({
    accessTokenEnc: 'enc-access',
    scopes: ['channel:bot', 'channel:read:redemptions'],
    ...partial,
  });
  fixture.broadcasterTokens.set(row.id, row);
  return row;
}

export function seedCommand(
  fixture: ReturnType<typeof creatorFixture>,
  partial: { id: string; channelId: string; name: string; [key: string]: unknown },
): any {
  const row = commandDefaults({ response: 'hi', createdBy: 'seed', ...partial });
  fixture.commands.set(row.id, row);
  return row;
}

export function seedTimer(
  fixture: ReturnType<typeof creatorFixture>,
  partial: { id: string; channelId: string; name: string; [key: string]: unknown },
): any {
  const row = timerDefaults({ message: 'hi', intervalMinutes: 10, createdBy: 'seed', ...partial });
  fixture.timers.set(row.id, row);
  return row;
}
