import { ValidationError } from '@pavisie/core';
import { describe, expect, it, vi } from 'vitest';
import { automodRuleConfigSchema, automodActionsSchema } from '../../automod/schemas';
import { configSchema as communitySchema, type CommunityConfig } from '../../community/manifest';
import { configSchema as engagementSchema, type EngagementConfig } from '../../engagement/manifest';
import { createTestContext } from '../../sdk/testing';
import {
  STARTER_AUTOMOD_RULES,
  STARTER_STATS_TEMPLATE,
  applyStreamerStarter,
  planStreamerStarter,
  streamerStarterResultKey,
  type StarterDeps,
  type StarterInput,
  type StarterPluginId,
  type StarterSnapshot,
} from '../starter-pack';
import { createAdminService } from '../service';
import { StarterAlreadyRunningError, runStreamerStarter } from '../starter-pack-runtime';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const normalizeLogin = (raw: string) => {
  const login = raw.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(login) ? login : null;
};

interface World {
  /** Plugin enabled state; every plugin starts off so the preset has something to turn on. */
  enabled: Record<StarterPluginId, boolean>;
  unavailable: Partial<Record<StarterPluginId, string>>;
  community: CommunityConfig;
  engagement: EngagementConfig;
  watched: string[];
  ruleTypes: string[];
  canManageChannels: boolean;
  twitchConfigured: boolean;
  createAlertError: Error | null;
  setCommunityError: Error | null;
  channelProblem: string | null;
}

function freshWorld(overrides: Partial<World> = {}): World {
  return {
    enabled: { integrations: false, community: false, engagement: false, automod: false },
    unavailable: {},
    community: communitySchema.parse({}) as CommunityConfig,
    engagement: engagementSchema.parse({}) as EngagementConfig,
    watched: [],
    ruleTypes: [],
    canManageChannels: true,
    twitchConfigured: true,
    createAlertError: null,
    setCommunityError: null,
    channelProblem: null,
    ...overrides,
  };
}

function buildDeps(world: World) {
  const calls = {
    enable: [] as StarterPluginId[],
    createAlert: [] as { login: string; channelId: string }[],
    createChannel: [] as string[],
    deleteChannel: [] as string[],
    createRule: [] as string[],
    setCommunity: [] as Partial<CommunityConfig>[],
    setEngagement: [] as Partial<EngagementConfig>[],
  };
  let channelCounter = 0;

  const deps: StarterDeps = {
    // Keys with their variables, so assertions can see both which message was used and what it was told.
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    pluginName: (id) => id,
    plugins: {
      availability: (id) =>
        world.unavailable[id] === undefined
          ? { available: true }
          : { available: false, reason: world.unavailable[id] },
      isEnabled: async (id) => world.enabled[id],
      enable: async (id) => {
        calls.enable.push(id);
        world.enabled[id] = true;
      },
      getCommunityConfig: async () => world.community,
      setCommunityConfig: async (patch) => {
        if (world.setCommunityError) throw world.setCommunityError;
        calls.setCommunity.push(patch);
        world.community = { ...world.community, ...patch };
      },
      getEngagementConfig: async () => world.engagement,
      setEngagementConfig: async (patch) => {
        calls.setEngagement.push(patch);
        world.engagement = { ...world.engagement, ...patch };
      },
    },
    twitch: {
      configured: () => world.twitchConfigured,
      normalizeLogin,
      watchedLogins: async () => world.watched,
      createAlert: async (login, channelId) => {
        if (world.createAlertError) throw world.createAlertError;
        calls.createAlert.push({ login, channelId });
        world.watched.push(login);
      },
      channelProblem: async () => world.channelProblem,
    },
    stats: {
      canManageChannels: () => world.canManageChannels,
      createChannel: async (template) => {
        calls.createChannel.push(template);
        channelCounter += 1;
        return { channelId: `33333333333333333${channelCounter}` };
      },
      deleteChannel: async (channelId) => {
        calls.deleteChannel.push(channelId);
      },
    },
    automod: {
      existingRuleTypes: async () => world.ruleTypes,
      createRule: async (rule) => {
        calls.createRule.push(rule.type);
        world.ruleTypes.push(rule.type);
      },
    },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  };
  return { deps, calls };
}

const WITH_LOGIN: StarterInput = { twitchLogin: 'Shroud', alertChannelId: CHANNEL };
const NO_LOGIN: StarterInput = { twitchLogin: null, alertChannelId: CHANNEL };

function stepOf(report: Awaited<ReturnType<typeof applyStreamerStarter>>, id: string) {
  const found = report.steps.find((s) => s.id === id);
  if (!found) throw new Error(`no ${id} step in report`);
  return found;
}

describe('applyStreamerStarter on a fresh server', () => {
  it('turns every feature on with the documented defaults', async () => {
    const world = freshWorld();
    const { deps, calls } = buildDeps(world);

    const report = await applyStreamerStarter(deps, GUILD, WITH_LOGIN);

    expect(report.steps.map((s) => [s.id, s.status])).toEqual([
      ['twitch', 'enabled'],
      ['stats', 'enabled'],
      ['leveling', 'enabled'],
      ['automod', 'enabled'],
    ]);
    expect(report.guildId).toBe(GUILD);
    expect(report.ranAt).toBe('2026-01-01T00:00:00.000Z');

    // Twitch: login normalized, posted to the channel given.
    expect(calls.createAlert).toEqual([{ login: 'shroud', channelId: CHANNEL }]);
    // Stats: one "Members: {members}" channel, saved into the community config.
    expect(calls.createChannel).toEqual([STARTER_STATS_TEMPLATE]);
    expect(world.community.statsChannels).toEqual([
      { channelId: '333333333333333331', template: 'Members: {members}' },
    ]);
    // Leveling on, automod rules created.
    expect(world.engagement.leveling.enabled).toBe(true);
    expect(calls.createRule.sort()).toEqual(['INVITE_LINKS', 'MENTION_SPAM', 'SCAM_LINKS']);
    // All four plugins switched on.
    expect(calls.enable.sort()).toEqual(['automod', 'community', 'engagement', 'integrations']);
    // The dry-run explanation reaches the admin.
    expect(report.notes.join('\n')).toContain('setup.streamer.automod.dryRunNote');
  });

  it('gives every step a title and a "where to change it" pointer', async () => {
    const { deps } = buildDeps(freshWorld());
    const report = await applyStreamerStarter(deps, GUILD, WITH_LOGIN);
    for (const s of report.steps) {
      expect(s.title).toBe(`setup.streamer.${s.id}.title`);
      expect(s.where).toBe(`setup.streamer.${s.id}.where`);
    }
  });
});

describe('idempotency', () => {
  it('a second run creates nothing and reports everything as already configured', async () => {
    const world = freshWorld();
    const { deps, calls } = buildDeps(world);

    await applyStreamerStarter(deps, GUILD, WITH_LOGIN);
    const second = await applyStreamerStarter(deps, GUILD, WITH_LOGIN);

    expect(second.steps.map((s) => [s.id, s.status])).toEqual([
      ['twitch', 'already'],
      ['stats', 'already'],
      ['leveling', 'already'],
      ['automod', 'already'],
    ]);
    // Exactly one of each across both runs.
    expect(calls.createAlert).toHaveLength(1);
    expect(calls.createChannel).toHaveLength(1);
    expect(calls.createRule).toHaveLength(3);
    expect(world.community.statsChannels).toHaveLength(1);
    // Leveling is on by default, so only the plugin switch (never its settings) was needed.
    expect(calls.setEngagement).toHaveLength(0);
    // And the second run did not enable anything again.
    expect(calls.enable).toHaveLength(4);
  });

  it('is case/format-insensitive about a login that is already watched', async () => {
    const world = freshWorld({ watched: ['shroud'] });
    const { deps, calls } = buildDeps(world);
    const report = await applyStreamerStarter(deps, GUILD, {
      twitchLogin: '@SHROUD',
      alertChannelId: CHANNEL,
    });
    expect(stepOf(report, 'twitch').status).toBe('already');
    expect(calls.createAlert).toHaveLength(0);
  });
});

describe('respecting existing configuration', () => {
  it('does not touch a watch, stats channel, or automod rule the admin already has', async () => {
    const world = freshWorld({
      enabled: { integrations: true, community: true, engagement: true, automod: true },
      watched: ['shroud'],
      ruleTypes: ['INVITE_LINKS', 'MENTION_SPAM', 'SCAM_LINKS'],
    });
    world.community = {
      ...world.community,
      statsChannels: [{ channelId: '444444444444444444', template: 'Boosts: {boosts}' }],
    };
    world.engagement = {
      ...world.engagement,
      leveling: { ...world.engagement.leveling, enabled: true, xpPerMessageMin: 40, xpPerMessageMax: 90 },
    };
    const { deps, calls } = buildDeps(world);

    const report = await applyStreamerStarter(deps, GUILD, WITH_LOGIN);

    expect(report.steps.every((s) => s.status === 'already')).toBe(true);
    expect(calls.enable).toEqual([]);
    expect(calls.createAlert).toEqual([]);
    expect(calls.createChannel).toEqual([]);
    expect(calls.createRule).toEqual([]);
    expect(calls.setCommunity).toEqual([]);
    expect(calls.setEngagement).toEqual([]);
    expect(world.community.statsChannels).toEqual([
      { channelId: '444444444444444444', template: 'Boosts: {boosts}' },
    ]);
    expect(world.engagement.leveling.xpPerMessageMax).toBe(90);
  });

  it('keeps custom leveling values when it only has to flip leveling back on', async () => {
    const world = freshWorld({
      enabled: { integrations: true, community: true, engagement: true, automod: true },
    });
    world.engagement = {
      ...world.engagement,
      leveling: {
        ...world.engagement.leveling,
        enabled: false,
        xpCooldownSeconds: 120,
        levelUpMessage: 'GG {user}, level {level}',
      },
    };
    const { deps } = buildDeps(world);

    await applyStreamerStarter(deps, GUILD, NO_LOGIN);

    expect(world.engagement.leveling.enabled).toBe(true);
    expect(world.engagement.leveling.xpCooldownSeconds).toBe(120);
    expect(world.engagement.leveling.levelUpMessage).toBe('GG {user}, level {level}');
  });

  it('only creates the automod rule types that are missing, whatever the existing rules are named', async () => {
    const world = freshWorld({
      enabled: { integrations: true, community: true, engagement: true, automod: true },
      ruleTypes: ['MENTION_SPAM'],
    });
    const { deps, calls } = buildDeps(world);

    const report = await applyStreamerStarter(deps, GUILD, NO_LOGIN);

    expect(calls.createRule.sort()).toEqual(['INVITE_LINKS', 'SCAM_LINKS']);
    expect(stepOf(report, 'automod').text).toContain('keptExisting');
    expect(stepOf(report, 'automod').text).toContain('MENTION_SPAM');
  });

  it('adds a second streamer when a different login is given', async () => {
    const world = freshWorld({ watched: ['someoneelse'] });
    const { deps, calls } = buildDeps(world);
    await applyStreamerStarter(deps, GUILD, WITH_LOGIN);
    expect(calls.createAlert).toEqual([{ login: 'shroud', channelId: CHANNEL }]);
  });

  it('does not switch on a plugin for a step that ends up adding nothing', async () => {
    // Stats exist already -> the (disabled) community plugin is left alone.
    const world = freshWorld();
    world.community = { ...world.community, statsChannels: [{ channelId: '4', template: 'x' }] };
    const { deps, calls } = buildDeps(world);
    await applyStreamerStarter(deps, GUILD, NO_LOGIN);
    expect(calls.enable).not.toContain('community');
  });
});

describe('missing permissions and unavailable features', () => {
  it('skips the stats channel without Manage Channels and still does everything else', async () => {
    const world = freshWorld({ canManageChannels: false });
    const { deps, calls } = buildDeps(world);

    const report = await applyStreamerStarter(deps, GUILD, WITH_LOGIN);

    const stats = stepOf(report, 'stats');
    expect(stats.status).toBe('skipped');
    expect(stats.text).toContain('setup.streamer.stats.missingPermission');
    expect(calls.createChannel).toEqual([]);
    expect(world.community.statsChannels).toEqual([]);
    expect(calls.enable).not.toContain('community');
    expect(stepOf(report, 'twitch').status).toBe('enabled');
    expect(stepOf(report, 'leveling').status).toBe('enabled');
    expect(stepOf(report, 'automod').status).toBe('enabled');
  });

  it('skips a step whose plugin is unavailable, naming the reason', async () => {
    const world = freshWorld({ unavailable: { automod: 'needs the Message Content intent' } });
    const { deps, calls } = buildDeps(world);
    const report = await applyStreamerStarter(deps, GUILD, WITH_LOGIN);
    const automod = stepOf(report, 'automod');
    expect(automod.status).toBe('skipped');
    expect(automod.text).toContain('needs the Message Content intent');
    expect(calls.createRule).toEqual([]);
    expect(calls.enable).not.toContain('automod');
  });

  it('skips the alert when this bot has no Twitch credentials', async () => {
    const { deps, calls } = buildDeps(freshWorld({ twitchConfigured: false }));
    const report = await applyStreamerStarter(deps, GUILD, WITH_LOGIN);
    expect(stepOf(report, 'twitch').status).toBe('skipped');
    expect(stepOf(report, 'twitch').text).toContain('twitch.unconfigured');
    expect(calls.createAlert).toEqual([]);
    expect(calls.enable).not.toContain('integrations');
  });

  it('warns (but still saves the alert) when the bot cannot post in the alert channel', async () => {
    const { deps, calls } = buildDeps(freshWorld({ channelProblem: 'Embed Links' }));
    const report = await applyStreamerStarter(deps, GUILD, WITH_LOGIN);
    expect(calls.createAlert).toHaveLength(1);
    expect(stepOf(report, 'twitch').status).toBe('enabled');
    expect(report.notes.join('\n')).toContain('twitch.channelProblem');
    expect(report.notes.join('\n')).toContain('Embed Links');
  });
});

describe('the no-login path', () => {
  it('turns Integrations on, adds no alert, and explains how to add one', async () => {
    const world = freshWorld();
    const { deps, calls } = buildDeps(world);

    const report = await applyStreamerStarter(deps, GUILD, { twitchLogin: null, alertChannelId: CHANNEL });

    const twitch = stepOf(report, 'twitch');
    expect(twitch.status).toBe('enabled');
    expect(twitch.text).toContain('setup.streamer.pluginEnabled');
    expect(twitch.text).toContain('setup.streamer.twitch.noLogin');
    expect(calls.enable).toContain('integrations');
    expect(calls.createAlert).toEqual([]);
  });

  it('treats a blank login the same as none', async () => {
    const { deps, calls } = buildDeps(freshWorld());
    const report = await applyStreamerStarter(deps, GUILD, { twitchLogin: '   ', alertChannelId: CHANNEL });
    expect(stepOf(report, 'twitch').text).toContain('twitch.noLogin');
    expect(calls.createAlert).toEqual([]);
  });

  it('reports "skipped" (nothing to add) when Integrations was already on and there is no login', async () => {
    const { deps } = buildDeps(
      freshWorld({ enabled: { integrations: true, community: true, engagement: true, automod: true } }),
    );
    const report = await applyStreamerStarter(deps, GUILD, NO_LOGIN);
    expect(stepOf(report, 'twitch').status).toBe('skipped');
  });

  it('says alerts already exist instead of nagging when there is no login but a watch exists', async () => {
    const { deps } = buildDeps(freshWorld({ watched: ['a', 'b'] }));
    const report = await applyStreamerStarter(deps, GUILD, NO_LOGIN);
    expect(stepOf(report, 'twitch').status).toBe('already');
    expect(stepOf(report, 'twitch').text).toContain('"count":2');
  });
});

describe('login and channel problems', () => {
  it('reports an unknown Twitch user as a failed step, and the other steps still run', async () => {
    const world = freshWorld({ createAlertError: new ValidationError('Twitch user "nobody" not found.') });
    const { deps } = buildDeps(world);

    const report = await applyStreamerStarter(deps, GUILD, {
      twitchLogin: 'nobody',
      alertChannelId: CHANNEL,
    });

    const twitch = stepOf(report, 'twitch');
    expect(twitch.status).toBe('failed');
    expect(twitch.text).toContain('Twitch user \\"nobody\\" not found.');
    expect(stepOf(report, 'stats').status).toBe('enabled');
    expect(stepOf(report, 'leveling').status).toBe('enabled');
    expect(stepOf(report, 'automod').status).toBe('enabled');
  });

  it('does not show an unexpected error message to the admin', async () => {
    const warn = vi.fn();
    const world = freshWorld({ createAlertError: new Error('connect ECONNREFUSED 10.0.0.5:5432') });
    const { deps } = buildDeps(world);
    deps.logger = { warn };
    const report = await applyStreamerStarter(deps, GUILD, WITH_LOGIN);
    expect(stepOf(report, 'twitch').text).not.toContain('ECONNREFUSED');
    expect(stepOf(report, 'twitch').text).toContain('setup.streamer.genericFailure');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('skips a malformed login without calling Twitch', async () => {
    const { deps, calls } = buildDeps(freshWorld());
    const report = await applyStreamerStarter(deps, GUILD, {
      twitchLogin: 'not a login!',
      alertChannelId: CHANNEL,
    });
    expect(stepOf(report, 'twitch').status).toBe('skipped');
    expect(stepOf(report, 'twitch').text).toContain('twitch.invalidLogin');
    expect(calls.createAlert).toEqual([]);
  });

  it('skips the alert when there is no channel to post in', async () => {
    const { deps, calls } = buildDeps(freshWorld());
    const report = await applyStreamerStarter(deps, GUILD, { twitchLogin: 'shroud', alertChannelId: null });
    expect(stepOf(report, 'twitch').status).toBe('skipped');
    expect(stepOf(report, 'twitch').text).toContain('twitch.noChannel');
    expect(calls.createAlert).toEqual([]);
  });
});

describe('stats channel failure handling', () => {
  it('removes the channel it just created when it cannot save it, so a retry does not duplicate it', async () => {
    const world = freshWorld({ setCommunityError: new Error('db down') });
    const { deps, calls } = buildDeps(world);

    const report = await applyStreamerStarter(deps, GUILD, NO_LOGIN);

    expect(stepOf(report, 'stats').status).toBe('failed');
    expect(calls.createChannel).toHaveLength(1);
    expect(calls.deleteChannel).toEqual(['333333333333333331']);
  });

  it('re-reads the stats list right before saving, so one added in the meantime survives', async () => {
    const world = freshWorld();
    const { deps } = buildDeps(world);
    const realCreate = deps.stats.createChannel;
    deps.stats.createChannel = async (template) => {
      world.community = {
        ...world.community,
        statsChannels: [{ channelId: '555555555555555555', template: 'Bots: {bots}' }],
      };
      return realCreate(template);
    };
    await applyStreamerStarter(deps, GUILD, NO_LOGIN);
    expect(world.community.statsChannels.map((c) => c.channelId)).toEqual([
      '555555555555555555',
      '333333333333333331',
    ]);
  });
});

describe('planStreamerStarter (pure)', () => {
  const baseSnapshot: StarterSnapshot = {
    plugins: {
      integrations: { available: true, enabled: false },
      community: { available: true, enabled: true },
      engagement: { available: true, enabled: true },
      automod: { available: true, enabled: true },
    },
    levelingEnabled: true,
    statsChannelCount: 0,
    twitchConfigured: true,
    watchedLogins: [],
    automodRuleTypes: [],
    canManageChannels: true,
  };

  it('is a pure function of the snapshot and the input', () => {
    const a = planStreamerStarter(baseSnapshot, WITH_LOGIN, normalizeLogin);
    const b = planStreamerStarter(baseSnapshot, WITH_LOGIN, normalizeLogin);
    expect(a).toEqual(b);
    expect(a.twitch).toEqual({
      enablePlugin: true,
      action: { kind: 'create', login: 'shroud', channelId: CHANNEL },
    });
    expect(a.stats).toEqual({ enablePlugin: false, action: { kind: 'create' } });
    expect(a.leveling.action).toEqual({ kind: 'already' });
  });
});

describe('the automod baseline', () => {
  it('uses existing rule types with valid configs and only deletes (no timeout, quarantine or ban)', () => {
    expect(STARTER_AUTOMOD_RULES.map((r) => r.type).sort()).toEqual([
      'INVITE_LINKS',
      'MENTION_SPAM',
      'SCAM_LINKS',
    ]);
    for (const rule of STARTER_AUTOMOD_RULES) {
      expect(automodRuleConfigSchema.safeParse(rule.config).success).toBe(true);
      expect(automodActionsSchema.safeParse(rule.actions).success).toBe(true);
      expect(rule.actions.map((a) => a.type)).toEqual(['delete']);
      expect((rule.config as { type: string }).type).toBe(rule.type);
    }
  });
});

describe('runStreamerStarter lock', () => {
  it('refuses a second concurrent run for the same server', async () => {
    const { ctx, redis } = createTestContext();
    await redis.set(`pavisie:admin:streamer-starter:lock:${GUILD}`, 'someone', 'EX', 60);
    await expect(
      runStreamerStarter({
        ctx,
        guild: { id: GUILD } as never,
        input: NO_LOGIN,
        actor: { id: 'u1', source: 'bot' },
        t: (key) => key,
      }),
    ).rejects.toBeInstanceOf(StarterAlreadyRunningError);
  });
});

describe('admin service (dashboard hand-off)', () => {
  it('stores a failed result instead of throwing when the run cannot start', async () => {
    const { ctx, redis, services } = createTestContext({
      overrides: {
        client: {
          guilds: {
            fetch: async () => {
              throw new Error('Unknown Guild');
            },
          },
        } as never,
      },
    });
    services.register('host', { getGuildConfig: async () => ({ locale: 'en' }) } as never);

    await createAdminService(ctx).streamerStarter({
      guildId: GUILD,
      payload: { requestId: 'req-1', twitchLogin: null, alertChannelId: null },
      requestedBy: 'u1',
    });

    const stored = JSON.parse((await redis.get(streamerStarterResultKey(GUILD, 'req-1'))) as string);
    expect(stored.status).toBe('failed');
    expect(typeof stored.error).toBe('string');
  });

  it('ignores a malformed payload without storing anything', async () => {
    const { ctx, redis } = createTestContext();
    await redis.flushall();
    await createAdminService(ctx).streamerStarter({
      guildId: GUILD,
      payload: { requestId: '' } as never,
      requestedBy: 'u1',
    });
    expect(await redis.keys('pavisie:admin:streamer-starter:*')).toEqual([]);
  });
});
