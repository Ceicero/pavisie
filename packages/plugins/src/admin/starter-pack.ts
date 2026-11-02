// The streamer starter pack: one preset that turns on go-live alerts, stats channels, leveling and a conservative
// automod baseline. `/setup streamer` and the dashboard's "Streamer starter pack" button both end up in
// `applyStreamerStarter` below, so the two can never drift (the dashboard's request is a `bot-actions` job that the
// bot runs through this same function — see starter-pack-runtime.ts).
//
// Everything here is free of discord.js / Prisma: the bot wires real implementations into `StarterDeps`, the tests
// wire fakes. The decision of what to do lives in `planStreamerStarter`, a pure function of a snapshot of the
// guild's current state, which is what makes "only fill gaps, never overwrite" checkable.
import { ValidationError, redisKey } from '@pavisie/core';
import type {
  StreamerStarterReportDto,
  StreamerStarterStepDto,
  StreamerStarterStepId,
  StreamerStarterStepStatus,
} from '@pavisie/types';
import type { CommunityConfig } from '../community/manifest';
import type { EngagementConfig } from '../engagement/manifest';

/** The plugins the preset can switch on. */
export type StarterPluginId = 'integrations' | 'community' | 'engagement' | 'automod';
export const STARTER_PLUGIN_IDS: readonly StarterPluginId[] = [
  'integrations',
  'community',
  'engagement',
  'automod',
];

/** Name of the category the stats channel is created under (an existing category with this exact name is reused). */
export const STARTER_STATS_CATEGORY_NAME = 'Server Stats';
/** Template of the locked voice channel that shows the member count. */
export const STARTER_STATS_TEMPLATE = 'Members: {members}';

export type StarterAutomodRuleType = 'INVITE_LINKS' | 'MENTION_SPAM' | 'SCAM_LINKS';

export interface StarterAutomodRule {
  type: StarterAutomodRuleType;
  name: string;
  /** Validated against `automodRuleConfigSchema` by the tests. */
  config: Record<string, unknown>;
  /** Log/delete only. The preset never times out, quarantines or bans anyone. */
  actions: { type: 'delete' }[];
}

/**
 * The automod baseline. Existing rule types only; every rule just deletes the message. The mention threshold is
 * deliberately higher than the rule's default of 5 so a streamer's excited chat is not caught. New rules are
 * created in dry-run like every other rule (see runtime), so nothing is deleted until the admin turns it on.
 */
export const STARTER_AUTOMOD_RULES: readonly StarterAutomodRule[] = [
  {
    type: 'INVITE_LINKS',
    name: 'Starter: invite links',
    config: { type: 'INVITE_LINKS', allowOwnServerInvites: true, allowedInviteCodes: [] },
    actions: [{ type: 'delete' }],
  },
  {
    type: 'MENTION_SPAM',
    name: 'Starter: mention spam',
    config: { type: 'MENTION_SPAM', maxMentions: 8, includeRoleMentions: true },
    actions: [{ type: 'delete' }],
  },
  {
    type: 'SCAM_LINKS',
    name: 'Starter: scam links',
    config: { type: 'SCAM_LINKS', useBuiltInList: true, blockedDomains: [] },
    actions: [{ type: 'delete' }],
  },
];

export interface StarterInput {
  /** Twitch login (or `@login` / `twitch.tv/login`) exactly as typed; null/empty = none given. */
  twitchLogin: string | null;
  /** Discord channel go-live alerts post to; required to add an alert. */
  alertChannelId: string | null;
}

export interface StarterSnapshot {
  plugins: Record<StarterPluginId, { available: boolean; reason?: string; enabled: boolean }>;
  /** `engagement.leveling.enabled`. */
  levelingEnabled: boolean;
  /** `community.statsChannels.length`. */
  statsChannelCount: number;
  /** Whether this Pavisie instance has the Twitch credentials alerts need. */
  twitchConfigured: boolean;
  /** Lower-case logins of the guild's active Twitch alert watches. */
  watchedLogins: string[];
  /** Types of the guild's non-deleted automod rules (enabled or not). */
  automodRuleTypes: string[];
  /** Whether the bot has Manage Channels in the guild. */
  canManageChannels: boolean;
}

export type TwitchAction =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'create'; login: string; channelId: string }
  | { kind: 'already'; login: string | null; count: number }
  | { kind: 'no_login' }
  | { kind: 'no_channel'; login: string }
  | { kind: 'invalid_login'; raw: string }
  | { kind: 'twitch_unconfigured' };

export type StatsAction =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'create' }
  | { kind: 'already'; count: number }
  | { kind: 'missing_permission' };

export type LevelingAction =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'turn_on'; enableLeveling: boolean }
  | { kind: 'already' };

export type AutomodAction =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'turn_on'; create: StarterAutomodRule[]; existing: StarterAutomodRuleType[] }
  | { kind: 'already'; existing: StarterAutomodRuleType[] };

export interface StarterPlan {
  twitch: { enablePlugin: boolean; action: TwitchAction };
  stats: { enablePlugin: boolean; action: StatsAction };
  leveling: { enablePlugin: boolean; action: LevelingAction };
  automod: { enablePlugin: boolean; action: AutomodAction };
}

/**
 * Decides what the preset will do, from the guild's current state alone. The rules, in one place:
 * - a feature that already has configuration (a watch for that login, any stats channel, a rule of that type) is
 *   never touched or duplicated, whatever its settings are;
 * - leveling and automod are "turn it on" steps (enable the plugin if it is off, switch leveling on if it is off),
 *   with every other setting left alone;
 * - go-live alerts and stats channels only switch their plugin on when they actually add something.
 */
export function planStreamerStarter(
  snapshot: StarterSnapshot,
  input: StarterInput,
  normalizeLogin: (raw: string) => string | null,
): StarterPlan {
  return {
    twitch: planTwitch(snapshot, input, normalizeLogin),
    stats: planStats(snapshot),
    leveling: planLeveling(snapshot),
    automod: planAutomod(snapshot),
  };
}

function planTwitch(
  snapshot: StarterSnapshot,
  input: StarterInput,
  normalizeLogin: (raw: string) => string | null,
): StarterPlan['twitch'] {
  const plugin = snapshot.plugins.integrations;
  if (!plugin.available) {
    return { enablePlugin: false, action: { kind: 'unavailable', reason: plugin.reason ?? 'unavailable' } };
  }
  const enablePlugin = !plugin.enabled;
  const raw = input.twitchLogin?.trim() ?? '';

  if (raw === '') {
    if (snapshot.watchedLogins.length > 0) {
      return {
        enablePlugin: false,
        action: { kind: 'already', login: null, count: snapshot.watchedLogins.length },
      };
    }
    return { enablePlugin, action: { kind: 'no_login' } };
  }

  const login = normalizeLogin(raw);
  if (!login) return { enablePlugin: false, action: { kind: 'invalid_login', raw } };
  if (snapshot.watchedLogins.includes(login)) {
    return { enablePlugin: false, action: { kind: 'already', login, count: snapshot.watchedLogins.length } };
  }
  if (!snapshot.twitchConfigured) return { enablePlugin: false, action: { kind: 'twitch_unconfigured' } };
  if (!input.alertChannelId) return { enablePlugin: false, action: { kind: 'no_channel', login } };
  return { enablePlugin, action: { kind: 'create', login, channelId: input.alertChannelId } };
}

function planStats(snapshot: StarterSnapshot): StarterPlan['stats'] {
  const plugin = snapshot.plugins.community;
  if (!plugin.available) {
    return { enablePlugin: false, action: { kind: 'unavailable', reason: plugin.reason ?? 'unavailable' } };
  }
  if (snapshot.statsChannelCount > 0) {
    return { enablePlugin: false, action: { kind: 'already', count: snapshot.statsChannelCount } };
  }
  if (!snapshot.canManageChannels) return { enablePlugin: false, action: { kind: 'missing_permission' } };
  return { enablePlugin: !plugin.enabled, action: { kind: 'create' } };
}

function planLeveling(snapshot: StarterSnapshot): StarterPlan['leveling'] {
  const plugin = snapshot.plugins.engagement;
  if (!plugin.available) {
    return { enablePlugin: false, action: { kind: 'unavailable', reason: plugin.reason ?? 'unavailable' } };
  }
  const enablePlugin = !plugin.enabled;
  const enableLeveling = !snapshot.levelingEnabled;
  if (!enablePlugin && !enableLeveling) return { enablePlugin: false, action: { kind: 'already' } };
  return { enablePlugin, action: { kind: 'turn_on', enableLeveling } };
}

function planAutomod(snapshot: StarterSnapshot): StarterPlan['automod'] {
  const plugin = snapshot.plugins.automod;
  if (!plugin.available) {
    return { enablePlugin: false, action: { kind: 'unavailable', reason: plugin.reason ?? 'unavailable' } };
  }
  const have = new Set(snapshot.automodRuleTypes);
  const existing = STARTER_AUTOMOD_RULES.filter((rule) => have.has(rule.type)).map((rule) => rule.type);
  const create = STARTER_AUTOMOD_RULES.filter((rule) => !have.has(rule.type));
  const enablePlugin = !plugin.enabled;
  if (create.length === 0 && !enablePlugin)
    return { enablePlugin: false, action: { kind: 'already', existing } };
  return { enablePlugin, action: { kind: 'turn_on', create: [...create], existing } };
}

// ---------------------------------------------------------------------------------------------------------------
// Applying the plan
// ---------------------------------------------------------------------------------------------------------------

type Vars = Record<string, string | number>;

/** Everything the preset needs from the outside world. The bot supplies real implementations (starter-pack-runtime.ts). */
export interface StarterDeps {
  t: (key: string, vars?: Vars) => string;
  /** Display name of a plugin, for "Turned on the X plugin". */
  pluginName: (id: StarterPluginId) => string;
  plugins: {
    availability: (id: StarterPluginId) => { available: boolean; reason?: string };
    isEnabled: (id: StarterPluginId) => Promise<boolean>;
    enable: (id: StarterPluginId) => Promise<void>;
    getCommunityConfig: () => Promise<CommunityConfig>;
    setCommunityConfig: (patch: Partial<CommunityConfig>) => Promise<void>;
    getEngagementConfig: () => Promise<EngagementConfig>;
    setEngagementConfig: (patch: Partial<EngagementConfig>) => Promise<void>;
  };
  twitch: {
    configured: () => boolean;
    normalizeLogin: (raw: string) => string | null;
    /** Lower-case logins of the guild's active Twitch alert watches. */
    watchedLogins: () => Promise<string[]>;
    /** Validates the login the same way `/integration alerts add` does; throws `ValidationError` for an unknown user. */
    createAlert: (login: string, channelId: string) => Promise<void>;
    /** Human-readable list of what the bot lacks to post in that channel, or null when it can post. */
    channelProblem: (channelId: string) => Promise<string | null>;
  };
  stats: {
    canManageChannels: () => boolean;
    /** Creates (or reuses) the "Server Stats" category and a locked voice channel under it. */
    createChannel: (template: string) => Promise<{ channelId: string }>;
    deleteChannel: (channelId: string) => Promise<void>;
  };
  automod: {
    existingRuleTypes: () => Promise<string[]>;
    createRule: (rule: StarterAutomodRule) => Promise<void>;
  };
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
  now?: () => Date;
}

interface StepOutcome {
  status: StreamerStarterStepStatus;
  lines: string[];
}

function step(deps: StarterDeps, id: StreamerStarterStepId, outcome: StepOutcome): StreamerStarterStepDto {
  const titles: Record<StreamerStarterStepId, string> = {
    twitch: deps.t('setup.streamer.twitch.title'),
    stats: deps.t('setup.streamer.stats.title'),
    leveling: deps.t('setup.streamer.leveling.title'),
    automod: deps.t('setup.streamer.automod.title'),
  };
  const where: Record<StreamerStarterStepId, string> = {
    twitch: deps.t('setup.streamer.twitch.where'),
    stats: deps.t('setup.streamer.stats.where'),
    leveling: deps.t('setup.streamer.leveling.where'),
    automod: deps.t('setup.streamer.automod.where'),
  };
  return { id, status: outcome.status, title: titles[id], text: outcome.lines.join('\n'), where: where[id] };
}

/** Message for an error inside a step: a `ValidationError` is written for users, anything else is logged, not shown. */
function describeError(deps: StarterDeps, stepId: StreamerStarterStepId, err: unknown): string {
  if (err instanceof ValidationError) return err.message;
  deps.logger?.warn(
    { stepId, err: err instanceof Error ? err.message : String(err) },
    'admin: streamer starter step failed',
  );
  return deps.t('setup.streamer.genericFailure');
}

async function turnPluginOn(deps: StarterDeps, id: StarterPluginId, lines: string[]): Promise<void> {
  await deps.plugins.enable(id);
  lines.push(deps.t('setup.streamer.pluginEnabled', { plugin: deps.pluginName(id) }));
}

async function gatherSnapshot(deps: StarterDeps): Promise<StarterSnapshot> {
  const plugins = {} as StarterSnapshot['plugins'];
  for (const id of STARTER_PLUGIN_IDS) {
    const availability = deps.plugins.availability(id);
    plugins[id] = {
      available: availability.available,
      reason: availability.reason,
      enabled: availability.available ? await deps.plugins.isEnabled(id) : false,
    };
  }
  const [community, engagement, watchedLogins, automodRuleTypes] = await Promise.all([
    deps.plugins.getCommunityConfig(),
    deps.plugins.getEngagementConfig(),
    deps.twitch.watchedLogins(),
    deps.automod.existingRuleTypes(),
  ]);
  return {
    plugins,
    levelingEnabled: engagement.leveling.enabled,
    statsChannelCount: community.statsChannels.length,
    twitchConfigured: deps.twitch.configured(),
    watchedLogins,
    automodRuleTypes,
    canManageChannels: deps.stats.canManageChannels(),
  };
}

/**
 * Runs the preset and reports what it did. Each of the four steps is independent: one failing (or being skipped)
 * never stops the others, and running it again after a partial run just fills what is still missing.
 */
export async function applyStreamerStarter(
  deps: StarterDeps,
  guildId: string,
  input: StarterInput,
): Promise<StreamerStarterReportDto> {
  const snapshot = await gatherSnapshot(deps);
  const plan = planStreamerStarter(snapshot, input, deps.twitch.normalizeLogin);
  const notes: string[] = [];

  const steps = [
    await runTwitch(deps, plan.twitch, notes),
    await runStats(deps, plan.stats),
    await runLeveling(deps, plan.leveling),
    await runAutomod(deps, plan.automod, notes),
  ];

  return { guildId, ranAt: (deps.now?.() ?? new Date()).toISOString(), steps, notes };
}

async function runTwitch(
  deps: StarterDeps,
  plan: StarterPlan['twitch'],
  notes: string[],
): Promise<StreamerStarterStepDto> {
  const { action } = plan;
  const lines: string[] = [];
  try {
    switch (action.kind) {
      case 'unavailable':
        return step(deps, 'twitch', {
          status: 'skipped',
          lines: [deps.t('setup.streamer.unavailable', { reason: action.reason })],
        });
      case 'twitch_unconfigured':
        return step(deps, 'twitch', {
          status: 'skipped',
          lines: [deps.t('setup.streamer.twitch.unconfigured')],
        });
      case 'invalid_login':
        return step(deps, 'twitch', {
          status: 'skipped',
          lines: [deps.t('setup.streamer.twitch.invalidLogin', { login: action.raw.slice(0, 60) })],
        });
      case 'no_channel':
        return step(deps, 'twitch', {
          status: 'skipped',
          lines: [deps.t('setup.streamer.twitch.noChannel', { login: action.login })],
        });
      case 'already':
        return step(deps, 'twitch', {
          status: 'already',
          lines: [
            action.login
              ? deps.t('setup.streamer.twitch.alreadyWatching', { login: action.login })
              : deps.t('setup.streamer.twitch.alreadyAny', { count: action.count }),
          ],
        });
      case 'no_login': {
        if (plan.enablePlugin) await turnPluginOn(deps, 'integrations', lines);
        lines.push(deps.t('setup.streamer.twitch.noLogin'));
        return step(deps, 'twitch', { status: plan.enablePlugin ? 'enabled' : 'skipped', lines });
      }
      case 'create': {
        if (plan.enablePlugin) await turnPluginOn(deps, 'integrations', lines);
        await deps.twitch.createAlert(action.login, action.channelId);
        lines.unshift(
          deps.t('setup.streamer.twitch.created', { login: action.login, channel: `<#${action.channelId}>` }),
        );
        const problem = await deps.twitch.channelProblem(action.channelId);
        if (problem) {
          notes.push(
            deps.t('setup.streamer.twitch.channelProblem', {
              channel: `<#${action.channelId}>`,
              missing: problem,
            }),
          );
        }
        return step(deps, 'twitch', { status: 'enabled', lines });
      }
    }
  } catch (err) {
    // The plugin may already have been switched on above; say so rather than hiding it behind the error.
    return step(deps, 'twitch', {
      status: 'failed',
      lines: [...lines, deps.t('setup.streamer.failed', { error: describeError(deps, 'twitch', err) })],
    });
  }
}

async function runStats(deps: StarterDeps, plan: StarterPlan['stats']): Promise<StreamerStarterStepDto> {
  const { action } = plan;
  switch (action.kind) {
    case 'unavailable':
      return step(deps, 'stats', {
        status: 'skipped',
        lines: [deps.t('setup.streamer.unavailable', { reason: action.reason })],
      });
    case 'already':
      return step(deps, 'stats', {
        status: 'already',
        lines: [deps.t('setup.streamer.stats.already', { count: action.count })],
      });
    case 'missing_permission':
      return step(deps, 'stats', {
        status: 'skipped',
        lines: [deps.t('setup.streamer.stats.missingPermission')],
      });
    case 'create': {
      const lines: string[] = [];
      let createdId: string | null = null;
      try {
        if (plan.enablePlugin) await turnPluginOn(deps, 'community', lines);
        const { channelId } = await deps.stats.createChannel(STARTER_STATS_TEMPLATE);
        createdId = channelId;
        // Re-read right before writing so a stats channel added in the meantime is kept, not overwritten.
        const current = await deps.plugins.getCommunityConfig();
        await deps.plugins.setCommunityConfig({
          statsChannels: [...current.statsChannels, { channelId, template: STARTER_STATS_TEMPLATE }],
        });
        lines.unshift(
          deps.t('setup.streamer.stats.created', {
            category: STARTER_STATS_CATEGORY_NAME,
            channel: `<#${channelId}>`,
            template: STARTER_STATS_TEMPLATE,
          }),
        );
        return step(deps, 'stats', { status: 'enabled', lines });
      } catch (err) {
        // A channel nothing refers to would be re-created on the next run, so take it back out.
        if (createdId) await deps.stats.deleteChannel(createdId).catch(() => undefined);
        return step(deps, 'stats', {
          status: 'failed',
          lines: [...lines, deps.t('setup.streamer.failed', { error: describeError(deps, 'stats', err) })],
        });
      }
    }
  }
}

async function runLeveling(
  deps: StarterDeps,
  plan: StarterPlan['leveling'],
): Promise<StreamerStarterStepDto> {
  const { action } = plan;
  switch (action.kind) {
    case 'unavailable':
      return step(deps, 'leveling', {
        status: 'skipped',
        lines: [deps.t('setup.streamer.unavailable', { reason: action.reason })],
      });
    case 'already':
      return step(deps, 'leveling', {
        status: 'already',
        lines: [deps.t('setup.streamer.leveling.already')],
      });
    case 'turn_on': {
      const lines: string[] = [];
      try {
        if (plan.enablePlugin) await turnPluginOn(deps, 'engagement', lines);
        if (action.enableLeveling) {
          // `leveling` is a nested object and config writes are shallow, so spread the current values back in:
          // only `enabled` changes, every XP/cooldown/message setting the admin chose is kept.
          const current = await deps.plugins.getEngagementConfig();
          await deps.plugins.setEngagementConfig({ leveling: { ...current.leveling, enabled: true } });
        }
        lines.unshift(deps.t('setup.streamer.leveling.enabled'));
        return step(deps, 'leveling', { status: 'enabled', lines });
      } catch (err) {
        return step(deps, 'leveling', {
          status: 'failed',
          lines: [...lines, deps.t('setup.streamer.failed', { error: describeError(deps, 'leveling', err) })],
        });
      }
    }
  }
}

async function runAutomod(
  deps: StarterDeps,
  plan: StarterPlan['automod'],
  notes: string[],
): Promise<StreamerStarterStepDto> {
  const { action } = plan;
  switch (action.kind) {
    case 'unavailable':
      return step(deps, 'automod', {
        status: 'skipped',
        lines: [deps.t('setup.streamer.unavailable', { reason: action.reason })],
      });
    case 'already':
      return step(deps, 'automod', {
        status: 'already',
        lines: [deps.t('setup.streamer.automod.already', { types: action.existing.join(', ') })],
      });
    case 'turn_on': {
      const lines: string[] = [];
      const created: string[] = [];
      try {
        if (plan.enablePlugin) await turnPluginOn(deps, 'automod', lines);
        for (const rule of action.create) {
          await deps.automod.createRule(rule);
          created.push(rule.name);
        }
        if (created.length > 0) {
          lines.unshift(
            deps.t('setup.streamer.automod.created', { count: created.length, names: created.join(', ') }),
          );
          notes.push(deps.t('setup.streamer.automod.dryRunNote'));
        }
        if (action.existing.length > 0) {
          lines.push(deps.t('setup.streamer.automod.keptExisting', { types: action.existing.join(', ') }));
        }
        return step(deps, 'automod', { status: 'enabled', lines });
      } catch (err) {
        const done =
          created.length > 0
            ? [deps.t('setup.streamer.automod.created', { count: created.length, names: created.join(', ') })]
            : [];
        return step(deps, 'automod', {
          status: 'failed',
          lines: [
            ...done,
            ...lines,
            deps.t('setup.streamer.failed', { error: describeError(deps, 'automod', err) }),
          ],
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Dashboard hand-off
// ---------------------------------------------------------------------------------------------------------------

/** Redis key the bot stores a dashboard-requested run's outcome under (a `StreamerStarterResultDto`), and the API reads. */
export function streamerStarterResultKey(guildId: string, requestId: string): string {
  return redisKey('admin', 'streamer-starter', guildId, requestId);
}

/** How long the dashboard has to pick a finished run up. */
export const STREAMER_STARTER_RESULT_TTL_SECONDS = 60 * 60;
