#!/usr/bin/env tsx
// Automod raid benchmark — a 50k-member server during a raid: hundreds of joins and messages per second.
//
//   pnpm --filter @pavisie/plugins exec tsx scripts/bench-automod-raid.ts            # load test + profile
//   pnpm --filter @pavisie/plugins exec tsx scripts/bench-automod-raid.ts --mode verify   # outcome digest
//
// What is real and what is simulated:
//   * Real: the automod pipeline (`handleMessage` / `handleMemberJoin`), Postgres (DATABASE_URL), Redis
//     (REDIS_URL) and the shared `GuildConfigStore` — the same services CI starts.
//   * Simulated: Discord. The guild, its 50k cached members and every REST call (delete a message, post an
//     alert, add a role, list invites) are in-process fakes. Each fake REST call waits `--discord-ms` and is
//     counted. Discord's rate limits are NOT simulated, so alert/delete latency here is a best case.
//
// The workload is generated from a fixed seed, so two runs offer exactly the same events in the same order.
//
// Modes:
//   load    (default) Open loop: events arrive on a fixed schedule whether or not earlier ones finished, the way
//           the gateway delivers them. Reports latency (scheduled arrival -> handler finished), backend calls
//           per event, and where handlers spent their time. "Clean-message latency" covers messages that broke
//           no rule and so made no Discord call — the cost automod adds to every ordinary member's message.
//   verify  Serial: one event at a time, in order. Prints two digests: one of every AutomodEvent written (what
//           automod decided) and one of every Discord call made (what it did and told staff). Both must be
//           identical before and after a pure performance change — they are the "same behavior" check.
//           Background jobs do not run in this mode, so the result never depends on how fast the replay went.
//
// Safety: refuses to run with NODE_ENV=production, and refuses a DATABASE_URL or REDIS_URL that is not on this
// machine unless --allow-remote is passed (needed inside docker-compose, where the hosts are `postgres`/`redis`).
// It only touches rows of its own guild (`bench-raid-guild`) and Redis keys containing `bench-raid`, and removes
// both when it finishes.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { Client, GuildMember, Message } from 'discord.js';
import Redis from 'ioredis';
import pino from 'pino';
import { MemoryRateLimiter, PlatformEvents, env as coreEnv, t as coreT } from '@pavisie/core';
import { prisma as basePrisma, type Prisma } from '@pavisie/database';
import { handleMemberJoin, handleMessage } from '../src/automod/service';
import { allPlugins } from '../src/index';
import { GuildConfigStore, PluginRegistry, ServiceRegistry, type PluginContext } from '../src/sdk';

// ---------------------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------------------

interface Options {
  mode: 'load' | 'verify';
  seconds: number;
  msgRate: number;
  joinRate: number;
  members: number;
  discordMs: number;
  manageGuild: boolean;
  seed: number;
  label: string;
  json: string | null;
  allowRemote: boolean;
  /** Also run raid mode's join handler on every join (the regression gate for raid mode). */
  raidMode: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    mode: 'load',
    seconds: 20,
    msgRate: 400,
    joinRate: 150,
    members: 50_000,
    discordMs: 60,
    manageGuild: false,
    seed: 20261110,
    label: 'run',
    json: null,
    allowRemote: false,
    raidMode: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const takeNumber = (): number => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} needs a non-negative number.`);
      i += 1;
      return parsed;
    };
    const takeString = (): string => {
      if (value === undefined) throw new Error(`${flag} needs a value.`);
      i += 1;
      return value;
    };
    switch (flag) {
      case '--mode': {
        const mode = takeString();
        if (mode !== 'load' && mode !== 'verify') throw new Error('--mode must be "load" or "verify".');
        options.mode = mode;
        break;
      }
      case '--seconds':
        options.seconds = takeNumber();
        break;
      case '--msg-rate':
        options.msgRate = takeNumber();
        break;
      case '--join-rate':
        options.joinRate = takeNumber();
        break;
      case '--members':
        options.members = takeNumber();
        break;
      case '--discord-ms':
        options.discordMs = takeNumber();
        break;
      case '--seed':
        options.seed = takeNumber();
        break;
      case '--allow-remote':
        options.allowRemote = true;
        break;
      case '--raid-mode':
        options.raidMode = true;
        break;
      case '--manage-guild':
        options.manageGuild = true;
        break;
      case '--label':
        options.label = takeString();
        break;
      case '--json':
        options.json = takeString();
        break;
      default:
        throw new Error(`Unknown option: ${String(flag)}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------------------------------------
// Instrumentation: every backend call is counted and timed under a label.
// ---------------------------------------------------------------------------------------------------------

interface Stat {
  count: number;
  totalMs: number;
}

class Recorder {
  readonly stats = new Map<string, Stat>();

  add(label: string, ms: number): void {
    const stat = this.stats.get(label);
    if (stat) {
      stat.count += 1;
      stat.totalMs += ms;
    } else {
      this.stats.set(label, { count: 1, totalMs: ms });
    }
  }

  async time<T>(label: string, run: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await run();
    } finally {
      this.add(label, performance.now() - start);
    }
  }

  reset(): void {
    this.stats.clear();
  }

  total(prefix: string): Stat {
    let count = 0;
    let totalMs = 0;
    for (const [label, stat] of this.stats) {
      if (!label.startsWith(prefix)) continue;
      count += stat.count;
      totalMs += stat.totalMs;
    }
    return { count, totalMs };
  }
}

/** Groups Redis keys into what the pipeline uses them for, so the profile reads as steps rather than key names. */
function redisPurpose(command: string, firstArg: string): string {
  if (firstArg.includes(':automod:window:')) return 'window counter';
  if (firstArg.includes(':automod:match:')) return 'match claim';
  if (firstArg.includes(':automod:raidlockdown:')) return 'raid lockdown flag';
  if (firstArg.includes(':cooldown:')) return 'rule cooldown';
  if (firstArg.includes(':guildcfg:')) return 'guild config cache';
  if (firstArg.includes(':cfg:')) return 'plugin config cache';
  if (firstArg.includes(':plugin:')) return 'plugin enabled cache';
  if (firstArg.includes(':automod:')) return 'automod cache';
  return command;
}

/**
 * Wraps `sendCommand`, the single choke point every ioredis command passes through, and records one entry per
 * network round trip: a lone command is one round trip, and a whole MULTI/EXEC pipeline is also one (its commands
 * arrive here tagged with a `pipelineIndex` and are written to the socket together).
 */
function instrumentRedis(redis: Redis, recorder: Recorder): void {
  interface SentCommand {
    name: string;
    args: unknown[];
    promise: Promise<unknown>;
    pipelineIndex?: number;
  }
  const original = redis.sendCommand.bind(redis) as (...args: unknown[]) => unknown;
  let group: { start: number; purpose: string | null } | null = null;

  redis.sendCommand = ((command: SentCommand, ...rest: unknown[]) => {
    const first = command.args[0];
    const key = typeof first === 'string' ? first : '';
    const record = (purpose: string, start: number): void => {
      const done = (): void => recorder.add(`redis  ${purpose}`, performance.now() - start);
      void command.promise.then(done, done);
    };

    if (command.pipelineIndex === undefined) {
      record(redisPurpose(command.name, key), performance.now());
    } else {
      if (command.pipelineIndex === 0 || !group) group = { start: performance.now(), purpose: null };
      if (!group.purpose && key) group.purpose = redisPurpose(command.name, key);
      if (command.name === 'exec') {
        record(group.purpose ?? 'pipeline', group.start);
        group = null;
      }
    }
    return original(command, ...rest);
  }) as typeof redis.sendCommand;
}

function instrumentPrisma(recorder: Recorder): PluginContext['prisma'] {
  const extended = basePrisma.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        return recorder.time(`pg     ${model ?? 'raw'}.${operation}`, () => query(args));
      },
    },
  });
  return extended as unknown as PluginContext['prisma'];
}

// ---------------------------------------------------------------------------------------------------------
// Deterministic workload
// ---------------------------------------------------------------------------------------------------------

/** mulberry32 — small, fast, seedable PRNG so every run offers the same events. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GUILD_ID = 'bench-raid-guild';
const BOT_ID = 'bench-raid-bot';
const OWNER_ID = 'bench-raid-owner';
const ALERT_CHANNEL_ID = 'bench-raid-alerts';
const QUARANTINE_ROLE_ID = 'bench-raid-quarantine';
const MOD_ROLE_ID = 'bench-raid-mods';
const CHANNEL_IDS = Array.from({ length: 40 }, (_, i) => `bench-raid-channel-${i}`);
const ROLE_IDS = Array.from({ length: 30 }, (_, i) => `bench-raid-role-${i}`);

const BENIGN_WORDS = (
  'the quick brown fox jumps over lazy dog anyone up for a match tonight i think that build is fine ' +
  'what time does the event start thanks for the help see you all later good game everyone new patch ' +
  'notes are out did you watch the stream yesterday that was great lol agreed maybe tomorrow sounds good'
).split(' ');

const RAID_SPAM_LINES = [
  'FREE NITRO FOR EVERYONE CLAIM NOW https://dlscord.com/gift/claim',
  'join the best server right now discord.gg/raidhq99 discord.gg/raidhq98',
  'free steam wallet codes here https://steamcommunlty.com/promo hurry',
  'GET YOUR REWARD TODAY!!!!!!!! EVERYONE LOOK AT THIS RIGHT NOW',
  'this server is dead come to ours instead, link in my profile',
];

/** A 200-word block list, the size a large server's word filter realistically reaches. */
const FILTERED_WORDS = Array.from({ length: 200 }, (_, i) => `blockedterm${i}`);

type BenchEvent =
  | { kind: 'join'; atMs: number; userId: string; accountAgeHours: number }
  | {
      kind: 'message';
      atMs: number;
      messageId: string;
      authorId: string;
      channelId: string;
      content: string;
      userMentions: number;
    };

function buildWorkload(options: Options): BenchEvent[] {
  const random = createRandom(options.seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const events: BenchEvent[] = [];
  const raiders: string[] = [];

  const joinCount = Math.floor(options.seconds * options.joinRate);
  for (let i = 0; i < joinCount; i += 1) {
    const userId = `bench-raid-raider-${i}`;
    events.push({
      kind: 'join',
      atMs: (i / options.joinRate) * 1000,
      userId,
      // Raid accounts are young: 90% under a day old.
      accountAgeHours: random() < 0.9 ? Math.floor(random() * 20) : 24 * (30 + Math.floor(random() * 300)),
    });
    raiders.push(userId);
  }

  const messageCount = Math.floor(options.seconds * options.msgRate);
  for (let i = 0; i < messageCount; i += 1) {
    const atMs = (i / options.msgRate) * 1000;
    // Raiders can only talk once they have joined; early in the run most traffic is still regular members.
    const joinedSoFar = Math.min(raiders.length, Math.floor((atMs / 1000) * options.joinRate));
    const fromRaider = joinedSoFar > 0 && random() < 0.7;
    if (fromRaider) {
      const authorId = raiders[Math.floor(random() * joinedSoFar)] as string;
      const line = pick(RAID_SPAM_LINES);
      const mentionBomb = random() < 0.1;
      events.push({
        kind: 'message',
        atMs,
        messageId: `bench-raid-msg-${i}`,
        authorId,
        channelId: pick(CHANNEL_IDS.slice(0, 6)),
        content: mentionBomb ? `${line} <@1> <@2> <@3> <@4> <@5> <@6> <@7> <@8>` : line,
        userMentions: mentionBomb ? 8 : 0,
      });
    } else {
      const length = 4 + Math.floor(random() * 14);
      const words = Array.from({ length }, () => pick(BENIGN_WORDS));
      if (random() < 0.05) words.push('https://example.com/patch-notes');
      events.push({
        kind: 'message',
        atMs,
        messageId: `bench-raid-msg-${i}`,
        authorId: `bench-raid-member-${Math.floor(random() * options.members)}`,
        channelId: pick(CHANNEL_IDS),
        content: words.join(' '),
        userMentions: 0,
      });
    }
  }

  // Stable sort: joins and messages interleave by arrival time; ties keep their generation order.
  return events.sort((a, b) => a.atMs - b.atMs);
}

// ---------------------------------------------------------------------------------------------------------
// Fake Discord
// ---------------------------------------------------------------------------------------------------------

interface FakeDiscord {
  client: Client<true>;
  makeMessage(event: Extract<BenchEvent, { kind: 'message' }>, baseTimeMs: number): Message;
  makeJoin(event: Extract<BenchEvent, { kind: 'join' }>, baseTimeMs: number): GuildMember;
  /** Every simulated REST call as `label|target`, in call order — part of the verify digest. */
  restLog: string[];
}

/** Per-event scratch space, so the report can tell events that needed a Discord call from those that did not. */
const eventScope = new AsyncLocalStorage<{ discordCalls: number }>();

function createFakeDiscord(options: Options, recorder: Recorder): FakeDiscord {
  const restLog: string[] = [];
  const rest = async (label: string, target: string): Promise<void> => {
    restLog.push(`${label}|${target}`);
    const scope = eventScope.getStore();
    if (scope) scope.discordCalls += 1;
    await recorder.time(`discord ${label}`, () => new Promise<void>((r) => setTimeout(r, options.discordMs)));
  };

  const permissions = (names: string[]) => ({ has: (name: unknown) => names.includes(String(name)) });
  const random = createRandom(options.seed ^ 0x5bd1e995);

  type FakeMember = {
    id: string;
    user: {
      id: string;
      bot: boolean;
      system: boolean;
      createdAt: Date;
      avatar: string | null;
      username: string;
      flags: null;
    };
    roles: { cache: Map<string, unknown>; add: (roleId: string) => Promise<void> };
    permissions: { has: (name: unknown) => boolean };
    joinedAt: Date;
    guild: unknown;
    timeout: () => Promise<void>;
  };

  interface AlertPayload {
    embeds?: { data?: { title?: string } }[];
  }
  const alertTitle = (payload: AlertPayload): string => payload.embeds?.[0]?.data?.title ?? '(no title)';
  let alertsPosted = 0;

  const members = new Map<string, FakeMember>();
  const guild = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    roles: { everyone: { id: GUILD_ID } },
    members: {
      cache: members,
      me: { id: BOT_ID, permissions: permissions(options.manageGuild ? ['ManageGuild'] : []) },
      fetch: async (userId: string) => {
        await rest('members.fetch', userId);
        return members.get(userId) ?? null;
      },
    },
    invites: {
      fetch: async () => {
        await rest('invites.fetch', GUILD_ID);
        return [{ code: 'ownserver1' }, { code: 'ownserver2' }, { code: 'ownserver3' }];
      },
    },
    channels: {
      fetch: async (channelId: string) => ({
        id: channelId,
        type: 0,
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => true }),
        // Logged under the alert's title (which names the rule), so the report can count alerts per rule.
        send: async (payload: AlertPayload) => {
          await rest('alert.send', alertTitle(payload));
          alertsPosted += 1;
          return { id: `bench-raid-alert-${alertsPosted}` };
        },
        messages: {
          edit: async (_messageId: string, payload: AlertPayload) => rest('alert.edit', alertTitle(payload)),
        },
      }),
    },
    setVerificationLevel: async () => rest('guild.setVerificationLevel', GUILD_ID),
  };

  const makeMember = (id: string, createdAt: Date, roleIds: string[]): FakeMember => {
    const member: FakeMember = {
      id,
      // avatar/username/flags: what raid mode's scorer reads. Default avatar, generic name, no Discord flags.
      user: { id, bot: false, system: false, createdAt, avatar: null, username: `member${id}`, flags: null },
      roles: {
        cache: new Map(roleIds.map((roleId) => [roleId, {}])),
        add: async (roleId: string) => {
          await rest('member.roles.add', id);
          member.roles.cache.set(roleId, {});
        },
      },
      permissions: permissions([]),
      joinedAt: new Date(0),
      guild,
      timeout: async () => rest('member.timeout', id),
    };
    return member;
  };

  const established = new Date(Date.UTC(2021, 0, 1));
  for (let i = 0; i < options.members; i += 1) {
    const roleCount = 1 + Math.floor(random() * 3);
    const roleIds = Array.from({ length: roleCount }, () => ROLE_IDS[Math.floor(random() * ROLE_IDS.length)]);
    members.set(
      `bench-raid-member-${i}`,
      makeMember(`bench-raid-member-${i}`, established, roleIds as string[]),
    );
  }

  const client = {
    user: { id: BOT_ID },
    guilds: { cache: new Map([[GUILD_ID, guild]]), fetch: async () => guild },
  };

  return {
    client: client as unknown as Client<true>,
    restLog,
    makeJoin(event, baseTimeMs) {
      const joinedAt = new Date(baseTimeMs + event.atMs);
      const member = makeMember(
        event.userId,
        new Date(joinedAt.getTime() - event.accountAgeHours * 3_600_000),
        [],
      );
      member.joinedAt = joinedAt;
      // discord.js caches the member before it emits guildMemberAdd.
      members.set(event.userId, member);
      return member as unknown as GuildMember;
    },
    makeMessage(event, baseTimeMs) {
      const member = members.get(event.authorId) ?? null;
      const message = {
        id: event.messageId,
        guildId: GUILD_ID,
        guild,
        channelId: event.channelId,
        channel: { id: event.channelId, nsfw: false },
        author: { id: event.authorId, bot: false, system: false },
        member,
        webhookId: null,
        content: event.content,
        mentions: { users: { size: event.userMentions }, roles: { size: 0 }, everyone: false },
        attachments: new Map(),
        createdAt: new Date(baseTimeMs + event.atMs),
        delete: async () => rest('message.delete', event.messageId),
      };
      return message as unknown as Message;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Seeding and cleanup
// ---------------------------------------------------------------------------------------------------------

/** A realistic rule set for a large server that has turned dry-run off: nine message rules, two join rules. */
function benchRules(mode: Options['mode']): Prisma.AutomodRuleCreateManyInput[] {
  // Sliding windows expire in Redis on real time, but a verify run replays the raid serially at whatever speed
  // the machine manages. Verify therefore uses the longest windows the schemas allow, so nothing can expire
  // mid-run and the outcome depends only on the order of events, never on how fast they were replayed.
  const verify = mode === 'verify';
  const base = {
    guildId: GUILD_ID,
    enabled: true,
    dryRun: false,
    exemptRoleIds: [MOD_ROLE_ID],
    exemptChannelIds: [CHANNEL_IDS[39] as string],
    exemptUserIds: [] as string[],
    trustedDomains: ['example.com'],
    createdBy: OWNER_ID,
  };
  const remove = [{ type: 'delete' }, { type: 'alert_staff' }];
  const rules: Array<{ type: string; config: object; actions: object[]; cooldownSeconds?: number }> = [
    // Long cooldowns, so a re-armed cooldown never depends on how fast the benchmark machine is.
    {
      type: 'MESSAGE_FREQUENCY',
      config: { maxMessages: 5, windowSeconds: verify ? 300 : 10 },
      actions: remove,
      cooldownSeconds: 300,
    },
    {
      type: 'DUPLICATE_MESSAGES',
      config: { maxDuplicates: 3, windowSeconds: verify ? 600 : 60 },
      actions: remove,
      cooldownSeconds: 300,
    },
    { type: 'MENTION_SPAM', config: { maxMentions: 5, includeRoleMentions: true }, actions: remove },
    {
      type: 'INVITE_LINKS',
      config: { allowOwnServerInvites: true, allowedInviteCodes: ['partner1'] },
      actions: remove,
    },
    {
      type: 'SCAM_LINKS',
      config: { useBuiltInList: true, blockedDomains: ['bad.example', 'worse.example'] },
      actions: remove,
    },
    { type: 'REGEX_FILTER', config: { pattern: 'c[l1]aim\\s+y[o0]ur', flags: 'i' }, actions: remove },
    {
      type: 'WORD_FILTER',
      config: { words: FILTERED_WORDS, wholeWord: true, caseSensitive: false },
      actions: remove,
    },
    {
      type: 'CAPS',
      config: { minLength: 10, maxCapsPercent: 70 },
      actions: [{ type: 'alert_staff' }],
      cooldownSeconds: 300,
    },
    {
      type: 'REPEATED_CHARS',
      config: { maxRepeats: 6 },
      actions: [{ type: 'alert_staff' }],
      cooldownSeconds: 300,
    },
    { type: 'ACCOUNT_AGE', config: { minAccountAgeHours: 24 }, actions: [{ type: 'quarantine' }] },
    {
      type: 'RAID_DETECTION',
      config: { joinBurstCount: 10, joinBurstWindowSeconds: verify ? 3600 : 30 },
      actions: [{ type: 'alert_staff' }],
      cooldownSeconds: 300,
    },
  ];
  return rules.map((rule, index) => ({
    ...base,
    id: `bench-raid-rule-${String(index).padStart(2, '0')}-${rule.type.toLowerCase()}`,
    name: `Bench ${rule.type}`,
    type: rule.type as Prisma.AutomodRuleCreateManyInput['type'],
    config: { type: rule.type, ...rule.config },
    actions: rule.actions,
    cooldownSeconds: rule.cooldownSeconds ?? 0,
    priority: index,
  }));
}

async function clearRedis(redis: Redis): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', '*bench-raid*', 'COUNT', 1000);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

async function cleanup(redis: Redis): Promise<void> {
  // AutomodEvent -> AutomodRule is `Restrict`, so events go first; the rest (raid mode's tables too) cascades
  // from the guild.
  await basePrisma.automodEvent.deleteMany({ where: { guildId: GUILD_ID } });
  await basePrisma.guild.deleteMany({ where: { id: GUILD_ID } });
  await clearRedis(redis);
}

async function seed(redis: Redis, options: Options): Promise<void> {
  await cleanup(redis);
  await basePrisma.guild.create({
    data: { id: GUILD_ID, name: 'Automod raid benchmark', ownerId: OWNER_ID, memberCount: options.members },
  });
  await basePrisma.guildConfig.create({
    // logMessageContent stays at its default (off): the benchmark never stores message text.
    data: { guildId: GUILD_ID, modRoleIds: [MOD_ROLE_ID] },
  });
  await basePrisma.pluginConfig.create({
    data: {
      guildId: GUILD_ID,
      pluginId: 'automod',
      config: {
        dryRun: false,
        alertChannelId: ALERT_CHANNEL_ID,
        quarantineRoleId: QUARANTINE_ROLE_ID,
        raidLockdown: 'quarantine-new-joins',
      },
    },
  });
  await basePrisma.automodRule.createMany({ data: benchRules(options.mode) });
  if (options.raidMode) {
    await basePrisma.pluginConfig.create({
      data: {
        guildId: GUILD_ID,
        pluginId: 'raidmode',
        // Dry run: detection, scoring and the alert run on every join; lockdown is a one-off and not part of the
        // per-join cost this gate measures.
        config: { dryRun: true, alertChannelId: ALERT_CHANNEL_ID, joinThreshold: 10, windowSeconds: 30 },
      },
    });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------------------------------------

type JobProcessor = (ctx: PluginContext, job: { data: unknown }) => Promise<void>;

/**
 * Stands in for the bot's queue workers: a job added with a delay runs its real processor after that delay.
 * `idle()` resolves once no job is waiting or running, which is how the load test waits for a raid alert to be
 * closed out. With no processor registered for a queue (or in verify mode, where timers would make the outcome
 * depend on run speed) added jobs are dropped, exactly like the old no-op stub.
 */
class JobRunner {
  private readonly processors = new Map<string, JobProcessor>();
  private outstanding = 0;
  private waiters: (() => void)[] = [];
  private ctx: PluginContext | null = null;
  failures: string[] = [];

  constructor(private readonly enabled: boolean) {}

  register(name: string, processor: JobProcessor): void {
    this.processors.set(name, processor);
  }

  attach(ctx: PluginContext): void {
    this.ctx = ctx;
  }

  queue(name: string): { add: (jobName: string, data: unknown, opts?: { delay?: number }) => Promise<void> } {
    return {
      add: async (_jobName, data, opts) => {
        const processor = this.processors.get(name);
        const ctx = this.ctx;
        if (!this.enabled || !processor || !ctx) return;
        this.outstanding += 1;
        setTimeout(() => {
          void processor(ctx, { data })
            .catch((err: unknown) => {
              this.failures.push(String(err));
            })
            .finally(() => {
              this.outstanding -= 1;
              if (this.outstanding === 0) {
                for (const wake of this.waiters.splice(0)) wake();
              }
            });
        }, opts?.delay ?? 0);
      },
    };
  }

  idle(): Promise<void> {
    if (this.outstanding === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

// ---------------------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable URL)';
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

function summarize(latencies: number[]): {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

const ms = (value: number): string => `${value.toFixed(value < 10 ? 2 : 0)} ms`;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run the benchmark in production.');
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
    throw new Error(
      'Set DATABASE_URL and REDIS_URL (see .env.example) — the benchmark needs real Postgres and Redis.',
    );
  }

  // `@pavisie/core` loads the repo's `.env` on import, so these URLs may have come from a file rather than the
  // shell. A benchmark that writes thousands of rows and drives hundreds of queries a second must not land on a
  // shared or production database because of what happened to be in `.env`.
  if (!options.allowRemote) {
    for (const name of ['DATABASE_URL', 'REDIS_URL'] as const) {
      const host = hostOf(process.env[name] as string);
      if (!LOCAL_HOSTS.has(host)) {
        throw new Error(
          `${name} points at "${host}", which is not this machine. Point it at a local or disposable instance, or pass --allow-remote if that host really is one.`,
        );
      }
    }
  }

  const recorder = new Recorder();
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  await seed(redis, options);
  instrumentRedis(redis, recorder);
  const prisma = instrumentPrisma(recorder);

  const registry = new PluginRegistry(allPlugins);
  const configStore = new GuildConfigStore(prisma as never, redis, registry);
  const services = new ServiceRegistry();
  // The real host service delegates `getGuildConfig` straight to the config store (apps/bot host-service.ts).
  services.register('host', {
    getGuildConfig: (guildId: string) => configStore.getGuildConfig(guildId),
  } as never);

  const discord = createFakeDiscord(options, recorder);
  const jobs = new JobRunner(options.mode === 'load');
  // Loaded dynamically so this same script still runs against a checkout from before the single raid alert
  // existed — that is how the "before" alert count is measured.
  const raidAlert = await import('../src/automod/raid-alert').catch(() => null);
  if (raidAlert)
    jobs.register(raidAlert.RAID_ALERT_JOB_NAME, raidAlert.raidAlertJob.processor as JobProcessor);
  // Same for the capped message alerts, so the "before" run of this script counts one alert per match.
  const messageAlert = await import('../src/automod/message-alert').catch(() => null);
  if (messageAlert)
    jobs.register(
      messageAlert.MESSAGE_ALERT_JOB_NAME,
      messageAlert.messageAlertJob.processor as JobProcessor,
    );
  const ctx: PluginContext = {
    client: discord.client,
    prisma,
    redis,
    logger: pino({ enabled: false }),
    events: new PlatformEvents(),
    rateLimiter: new MemoryRateLimiter(),
    queue: (name: string) => jobs.queue(name) as never,
    getConfig: <T>(guildId: string) => configStore.getConfig<T>(guildId, 'automod'),
    setConfig: <T>() => Promise.resolve({} as T),
    isEnabled: (guildId: string) => configStore.isEnabled(guildId, 'automod'),
    services,
    audit: async () => undefined,
    t: coreT,
    env: coreEnv,
    botOwnerIds: [],
    intentsEnabled: { messageContent: true, guildMembers: true, guildPresences: false },
  };

  jobs.attach(ctx);

  // Raid mode is a separate plugin: the host gives it its own context (its own config) and runs its listener
  // alongside automod's for the same join.
  const raidModeModule = options.raidMode ? await import('../src/raidmode/incident') : null;
  const raidCtx: PluginContext | null = raidModeModule
    ? {
        ...ctx,
        getConfig: <T>(guildId: string) => configStore.getConfig<T>(guildId, 'raidmode'),
        isEnabled: (guildId: string) => configStore.isEnabled(guildId, 'raidmode'),
        queue: (name: string) => jobs.queue(`raidmode.${name}`) as never,
      }
    : null;
  if (raidModeModule)
    jobs.register(
      `raidmode.${raidModeModule.UPDATE_JOB_NAME}`,
      raidModeModule.updateJob.processor as JobProcessor,
    );

  const workload = buildWorkload(options);
  // Message/join timestamps feed the sliding windows, so they are anchored to one fixed instant per run.
  const baseTimeMs = Date.now();
  const failures: string[] = [];

  // Mirrors the host's listener (apps/bot loader.ts): check the plugin is enabled for the guild, then run the handler.
  const dispatch = async (event: BenchEvent): Promise<void> => {
    if (!(await ctx.isEnabled(GUILD_ID))) return;
    if (event.kind === 'join') {
      const member = discord.makeJoin(event, baseTimeMs);
      if (raidModeModule && raidCtx) {
        await Promise.all([handleMemberJoin(ctx, member), raidModeModule.handleJoin(raidCtx, member)]);
      } else {
        await handleMemberJoin(ctx, member);
      }
    } else await handleMessage(ctx, discord.makeMessage(event, baseTimeMs));
  };

  // Warm caches the way a running bot has them warm, then measure only the raid itself.
  await ctx.isEnabled(GUILD_ID);
  await ctx.getConfig(GUILD_ID);
  await configStore.getGuildConfig(GUILD_ID);
  recorder.reset();

  const latencies = { message: [] as number[], cleanMessage: [] as number[], join: [] as number[] };
  const cpuStart = process.cpuUsage();
  const loopStart = performance.eventLoopUtilization();
  const wallStart = performance.now();
  let maxInFlight = 0;

  if (options.mode === 'verify') {
    for (const event of workload) {
      await dispatch(event).catch((err: unknown) => failures.push(String(err)));
    }
  } else {
    let inFlight = 0;
    const pending: Promise<void>[] = [];
    let next = 0;
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        const elapsed = performance.now() - wallStart;
        while (next < workload.length && (workload[next] as BenchEvent).atMs <= elapsed) {
          const event = workload[next] as BenchEvent;
          next += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const scope = { discordCalls: 0 };
          pending.push(
            eventScope
              .run(scope, () => dispatch(event))
              .catch((err: unknown) => {
                failures.push(String(err));
              })
              .then(() => {
                inFlight -= 1;
                const latency = performance.now() - wallStart - event.atMs;
                latencies[event.kind].push(latency);
                // A message that broke no rule needed no Discord call: its latency is pure evaluation cost.
                if (event.kind === 'message' && scope.discordCalls === 0)
                  latencies.cleanMessage.push(latency);
              }),
          );
        }
        if (next >= workload.length) resolve();
        else setTimeout(tick, 2);
      };
      tick();
    });
    await Promise.all(pending);
  }

  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  const loop = performance.eventLoopUtilization(loopStart);

  // Latency and CPU are measured over the raid itself. Background jobs (the raid alert's running count and its
  // final "raid ended" edit) carry on afterwards; wait for them so the alert counts below are complete.
  await jobs.idle();
  const settledMs = performance.now() - wallStart;
  failures.push(...jobs.failures);

  // Outcome digest: what automod decided and did, independent of timing.
  const events = await basePrisma.automodEvent.findMany({
    where: { guildId: GUILD_ID },
    select: {
      ruleId: true,
      userId: true,
      messageId: true,
      channelId: true,
      dryRun: true,
      actionsTaken: true,
    },
  });
  const eventLines = events
    .map(
      (e) =>
        `${e.ruleId}|${e.userId}|${e.messageId ?? ''}|${e.channelId ?? ''}|${JSON.stringify(e.actionsTaken)}`,
    )
    .sort();
  const restLines = options.mode === 'verify' ? discord.restLog : [...discord.restLog].sort();
  // Two digests, so a change to what staff are told (Discord calls) can be told apart from a change to what
  // automod decided (the AutomodEvent rows).
  const eventsDigest = createHash('sha256').update(eventLines.join('\n')).digest('hex');
  const discordDigest = createHash('sha256').update(restLines.join('\n')).digest('hex');
  const countRest = (label: string, titlePart = ''): number =>
    discord.restLog.filter((line) => line.startsWith(`${label}|`) && line.includes(titlePart)).length;
  const alerts = {
    posted: countRest('alert.send'),
    edits: countRest('alert.edit'),
    raidPosted: countRest('alert.send', 'RAID_DETECTION'),
    raidEdits: countRest('alert.edit', 'RAID_DETECTION'),
  };
  const eventsByRule = new Map<string, number>();
  for (const e of events) eventsByRule.set(e.ruleId, (eventsByRule.get(e.ruleId) ?? 0) + 1);

  const total = workload.length;
  const pg = recorder.total('pg ');
  const redisTotal = recorder.total('redis ');
  const discordTotal = recorder.total('discord ');
  const message = summarize(latencies.message);
  const cleanMessage = summarize(latencies.cleanMessage);
  const join = summarize(latencies.join);
  const offeredPerSecond = options.msgRate + options.joinRate;

  const lines: string[] = [];
  lines.push(`Automod raid benchmark — ${options.label} (${options.mode} mode)`);
  lines.push(
    `  ${options.members.toLocaleString('en-US')} members, ${options.msgRate} msg/s + ${options.joinRate} joins/s for ${options.seconds}s ` +
      `(${total.toLocaleString('en-US')} events), Discord call ${options.discordMs} ms, ` +
      `bot ${options.manageGuild ? 'has' : 'lacks'} Manage Server, seed ${options.seed}`,
  );
  lines.push('');
  if (options.mode === 'load') {
    lines.push(`  Offered load          ${offeredPerSecond} events/s`);
    lines.push(
      `  Time to finish all    ${(wallMs / 1000).toFixed(1)} s (the load itself lasts ${options.seconds} s)`,
    );
    lines.push(`  Peak events in flight ${maxInFlight}`);
    lines.push(
      `  Message latency       p50 ${ms(message.p50)}  p95 ${ms(message.p95)}  p99 ${ms(message.p99)}  max ${ms(message.max)}`,
    );
    lines.push(
      `  Clean-message latency p50 ${ms(cleanMessage.p50)}  p95 ${ms(cleanMessage.p95)}  p99 ${ms(cleanMessage.p99)}  max ${ms(cleanMessage.max)}  (${cleanMessage.count} messages that broke no rule)`,
    );
    lines.push(
      `  Join latency          p50 ${ms(join.p50)}  p95 ${ms(join.p95)}  p99 ${ms(join.p99)}  max ${ms(join.max)}`,
    );
    lines.push(
      `  CPU time used         ${((cpu.user + cpu.system) / 1000 / 1000).toFixed(1)} s, event loop ${(loop.utilization * 100).toFixed(0)}% busy`,
    );
    lines.push('');
  }
  lines.push('  Backend calls per event');
  lines.push(`    Postgres queries    ${(pg.count / total).toFixed(2)}`);
  lines.push(`    Redis round trips   ${(redisTotal.count / total).toFixed(2)}`);
  lines.push(`    Discord REST calls  ${(discordTotal.count / total).toFixed(2)}`);
  lines.push('');
  lines.push('  Where handlers waited (summed across concurrent handlers)');
  const ranked = [...recorder.stats.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
  for (const [label, stat] of ranked) {
    lines.push(
      `    ${label.padEnd(36)} ${String(stat.count).padStart(7)} calls  ${(stat.totalMs / 1000).toFixed(1).padStart(8)} s  avg ${ms(stat.totalMs / stat.count)}`,
    );
  }
  lines.push('');
  lines.push(`  AutomodEvent rows written: ${events.length}`);
  for (const [ruleId, count] of [...eventsByRule.entries()].sort())
    lines.push(`    ${ruleId.padEnd(48)} ${count}`);
  lines.push('');
  lines.push(`  Staff alert messages posted: ${alerts.posted} (${alerts.edits} edits)`);
  lines.push(`    for the raid-detection rule:  ${alerts.raidPosted} posted, ${alerts.raidEdits} edits`);
  if (options.mode === 'load') {
    lines.push(`    alerts settled ${(settledMs / 1000).toFixed(0)} s after the raid began`);
  }
  lines.push(`  Handler errors: ${failures.length}${failures.length > 0 ? ` (first: ${failures[0]})` : ''}`);
  if (options.mode === 'verify') {
    lines.push(`  Events digest (what automod decided):  ${eventsDigest}`);
    lines.push(`  Discord digest (what it did and said): ${discordDigest}`);
    // Rule cooldowns and match claims last 300 s of real time; past that the digest would depend on run speed.
    if (wallMs > 240_000)
      lines.push('  WARNING: run took over 240 s; the digest may not be reproducible. Use fewer --seconds.');
  }
  // eslint-disable-next-line no-console -- CLI report output
  console.log(lines.join('\n'));

  if (options.json) {
    const report = {
      label: options.label,
      options,
      events: total,
      wallMs,
      maxInFlight,
      latency: { message, cleanMessage, join },
      cpuSeconds: (cpu.user + cpu.system) / 1e6,
      eventLoopUtilization: loop.utilization,
      perEvent: {
        postgresQueries: pg.count / total,
        redisRoundTrips: redisTotal.count / total,
        discordCalls: discordTotal.count / total,
      },
      profile: Object.fromEntries(ranked),
      automodEvents: events.length,
      handlerErrors: failures.length,
      alerts,
      settledMs,
      eventsDigest: options.mode === 'verify' ? eventsDigest : null,
      discordDigest: options.mode === 'verify' ? discordDigest : null,
    };
    await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  await cleanup(redis);
  await redis.quit();
  await basePrisma.$disconnect();
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('bench-automod-raid failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
