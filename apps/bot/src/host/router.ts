import type {
  AnySelectMenuInteraction,
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ContextMenuCommandInteraction,
  Guild,
  GuildBasedChannel,
  Interaction,
  ModalSubmitInteraction,
  PermissionResolvable,
  RepliableInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import { isAppError, resolveLocale, t as coreT } from '@pavisie/core';
import {
  assertBotPermissions,
  errorEmbed,
  handlePaginationInteraction,
  parseCustomId,
  PAGINATION_ACTION,
  type AutocompleteContext,
  type CommandContext,
  type ComponentContext,
  type ContextMenuContext,
  type PluginContext,
} from '@pavisie/plugins';
import type { PluginId } from '@pavisie/types';
import type { LoadedHost } from './loader';
import {
  cooldownKey,
  evaluateRequirement,
  globalLimiterKey,
  requirementFailureMessage,
  resolveInteractionStaffLevel,
  type TFunction,
} from './permissions';

const GLOBAL_LIMIT = 20;
const GLOBAL_WINDOW_MS = 10_000;

/** Replies (or follows up, if the interaction already replied/deferred) with an ephemeral error embed. Never throws. */
async function replyError(interaction: RepliableInteraction, message: string, logger: Logger): Promise<void> {
  const payload = { embeds: [errorEmbed(message)], ephemeral: true };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    logger.error({ err }, 'router: failed to deliver an error reply to the user');
  }
}

/**
 * Converts a thrown value into a user-facing message and logs it (unless it's an expected, already-safe
 * `AppError` such as `PermissionError`/`ValidationError`, whose message was already written for end users at
 * the throw site — see `assertStaffLevel`/`hierarchyGuard`/`assertBotPermissions`). Never leaks a stack trace.
 */
function messageForThrown(
  err: unknown,
  t: TFunction,
  logger: Logger,
  context: Record<string, unknown>,
): string {
  if (isAppError(err) && err.expose) {
    return err.message;
  }
  logger.error(
    { ...context, err: err instanceof Error ? err.message : String(err) },
    'router: handler threw an unexpected error',
  );
  return t('errors.generic');
}

function boundTFor(ctx: PluginContext, interactionLocale: string): TFunction {
  const locale = resolveLocale(interactionLocale);
  return (key, vars) => ctx.t(key, vars, locale);
}

interface RequirementLike {
  staffLevel?: CommandContext['staffLevel'];
  discordPermissions?: PermissionResolvable[];
  botPermissions?: PermissionResolvable[];
  botOwnerOnly?: boolean;
}

/**
 * Runs the shared requirement pipeline for a command or component: bot-owner-only / staff-level / Discord-permission
 * checks (`evaluateRequirement`), then bot-permission checks (`assertBotPermissions`, which needs a real channel/guild
 * object), then the global per-user limiter, then (commands only, via `cooldown`/`commandNameForCooldown`) the
 * per-command cooldown. Returns `true` if the interaction may proceed; on failure it has already replied and
 * returns `false`.
 */
async function checkAndConsume(params: {
  interaction: RepliableInteraction;
  host: LoadedHost;
  logger: Logger;
  t: TFunction;
  requirement: RequirementLike | undefined;
  staffLevel: CommandContext['staffLevel'];
  actorPermissionsBitfield: bigint;
  userId: string;
  guild: Guild;
  channel: GuildBasedChannel | null;
  commandNameForCooldown?: string;
  cooldown?: { seconds: number; scope: 'user' | 'guild' | 'channel' };
}): Promise<boolean> {
  const {
    interaction,
    host,
    logger,
    t,
    requirement,
    staffLevel,
    actorPermissionsBitfield,
    userId,
    guild,
    channel,
  } = params;

  const evalResult = evaluateRequirement({
    requirement,
    staffLevel,
    actorPermissionsBitfield,
    userId,
    botOwnerIds: host.botOwnerIds,
  });
  if (!evalResult.ok) {
    await replyError(interaction, requirementFailureMessage(evalResult, t), logger);
    return false;
  }

  if (requirement?.botPermissions && requirement.botPermissions.length > 0) {
    try {
      assertBotPermissions(channel ?? guild, requirement.botPermissions, t);
    } catch (err) {
      await replyError(interaction, messageForThrown(err, t, logger, { userId, guildId: guild.id }), logger);
      return false;
    }
  }

  const globalResult = await host.globalRateLimiter.consume(
    globalLimiterKey(userId),
    GLOBAL_LIMIT,
    GLOBAL_WINDOW_MS,
  );
  if (!globalResult.allowed) {
    await replyError(interaction, t('errors.rate_limited'), logger);
    return false;
  }

  if (params.cooldown && params.commandNameForCooldown) {
    const key = cooldownKey(params.commandNameForCooldown, params.cooldown.scope, {
      userId,
      guildId: guild.id,
      channelId: channel?.id ?? guild.id,
    });
    const result = await host.cooldowns.take(key, params.cooldown.seconds);
    if (!result.ok) {
      await replyError(
        interaction,
        t('errors.cooldown', { seconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000)) }),
        logger,
      );
      return false;
    }
  }

  return true;
}

/** Checks plugin availability (env/intents) and per-guild enablement, replying with an ephemeral message if either fails. */
async function checkPluginGate(params: {
  interaction: RepliableInteraction;
  host: LoadedHost;
  logger: Logger;
  t: TFunction;
  pluginId: PluginId;
  pluginName: string;
  alwaysEnabled: boolean | undefined;
  guildId: string;
}): Promise<boolean> {
  const { interaction, logger, ...gate } = params;
  const failure = await pluginGateFailure(gate);
  if (!failure) return true;
  await replyError(interaction, failure, logger);
  return false;
}

/**
 * The gate itself: is this plugin available (env/intents) and enabled for this guild? Returns the user-facing
 * reason it may not run, or `null` when it may. Kept free of interaction side effects so autocomplete — which
 * has no reply to make — can consult it too.
 */
async function pluginGateFailure(params: {
  host: LoadedHost;
  t: TFunction;
  pluginId: PluginId;
  pluginName: string;
  alwaysEnabled: boolean | undefined;
  guildId: string;
}): Promise<string | null> {
  const { host, t, pluginId, pluginName, alwaysEnabled, guildId } = params;

  const availability = host.availability.get(pluginId);
  if (!availability?.available) {
    return t('errors.plugin_unavailable', { plugin: pluginName, reason: availability?.reason ?? 'unknown' });
  }

  if (!alwaysEnabled) {
    const enabled = await host.configStore.isEnabled(guildId, pluginId);
    if (!enabled) return t('errors.plugin_disabled', { plugin: pluginName });
  }

  return null;
}

/** Top-level `interactionCreate` dispatcher (ARCHITECTURE.md §9). */
export async function routeInteraction(
  interaction: Interaction,
  host: LoadedHost,
  logger: Logger,
): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction, host, logger);
    return;
  }
  if (interaction.isContextMenuCommand()) {
    await handleContextMenu(interaction, host, logger);
    return;
  }
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction, host, logger);
    return;
  }
  if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
    await handleComponent(interaction, host, logger);
    return;
  }
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  host: LoadedHost,
  logger: Logger,
): Promise<void> {
  const entry = host.commands.get(interaction.commandName);
  if (!entry) {
    await replyError(interaction, coreT('errors.not_found', { thing: 'Command' }), logger);
    return;
  }
  const { plugin, command } = entry;
  const pluginId = plugin.manifest.id;

  // `CommandContext.interaction` is typed as a cached-guild interaction, so every command effectively requires
  // guild context regardless of `requirement.guildOnly` — every command builder also sets `.setDMPermission(false)`
  // (ARCHITECTURE.md §7.7), so Discord itself never delivers a DM interaction for these commands in practice.
  if (!interaction.inCachedGuild()) {
    await replyError(interaction, coreT('errors.guild_only'), logger);
    return;
  }

  const ctx = host.contexts.get(pluginId);
  if (!ctx) {
    await replyError(interaction, coreT('errors.generic'), logger);
    return;
  }
  const t = boundTFor(ctx, interaction.locale);

  const gateOk = await checkPluginGate({
    interaction,
    host,
    logger,
    t,
    pluginId,
    pluginName: plugin.manifest.name,
    alwaysEnabled: plugin.manifest.alwaysEnabled,
    guildId: interaction.guildId,
  });
  if (!gateOk) return;

  const guildConfig = await host.configStore.getGuildConfig(interaction.guildId);
  const staffLevel = resolveInteractionStaffLevel({
    member: interaction.member,
    guildOwnerId: interaction.guild.ownerId,
    botOwnerIds: host.botOwnerIds,
    staffRoles: {
      adminRoleIds: guildConfig.adminRoleIds,
      modRoleIds: guildConfig.modRoleIds,
      helperRoleIds: guildConfig.helperRoleIds,
    },
  });

  const channel = interaction.channel && 'guild' in interaction.channel ? interaction.channel : null;
  const proceed = await checkAndConsume({
    interaction,
    host,
    logger,
    t,
    requirement: command.requirement,
    staffLevel,
    actorPermissionsBitfield: interaction.member.permissions.bitfield,
    userId: interaction.user.id,
    guild: interaction.guild,
    channel,
    commandNameForCooldown: interaction.commandName,
    cooldown: command.requirement?.cooldown,
  });
  if (!proceed) return;

  const commandContext: CommandContext = {
    interaction,
    ctx,
    guildId: interaction.guildId,
    staffLevel,
    locale: interaction.locale,
    t,
    config: <T>() => ctx.getConfig<T>(interaction.guildId),
  };

  try {
    await command.execute(commandContext);
  } catch (err) {
    await replyError(
      interaction,
      messageForThrown(err, t, logger, { plugin: pluginId, command: interaction.commandName }),
      logger,
    );
  }
}

async function handleContextMenu(
  interaction: ContextMenuCommandInteraction,
  host: LoadedHost,
  logger: Logger,
): Promise<void> {
  // `ContextMenuCommandInteraction` (the umbrella class type) doesn't structurally satisfy `RepliableInteraction`,
  // which is a union of its two concrete subclasses (`Message`/`UserContextMenuCommandInteraction`) — reply/followUp
  // behave identically on both, so this is a safe narrowing cast, same pattern used elsewhere for interaction
  // subtype friction (sdk/confirm.ts, admin/components/wizard.ts).
  const repliable = interaction as unknown as RepliableInteraction;

  const entry = host.commands.get(interaction.commandName);
  if (!entry) {
    await replyError(repliable, coreT('errors.not_found', { thing: 'Command' }), logger);
    return;
  }
  const { plugin, command } = entry;
  const pluginId = plugin.manifest.id;

  if (!command.executeContextMenu) {
    await replyError(repliable, coreT('errors.not_found', { thing: 'Command' }), logger);
    return;
  }

  if (!interaction.inCachedGuild()) {
    await replyError(repliable, coreT('errors.guild_only'), logger);
    return;
  }

  const ctx = host.contexts.get(pluginId);
  if (!ctx) {
    await replyError(repliable, coreT('errors.generic'), logger);
    return;
  }
  const t = boundTFor(ctx, interaction.locale);

  const gateOk = await checkPluginGate({
    interaction: repliable,
    host,
    logger,
    t,
    pluginId,
    pluginName: plugin.manifest.name,
    alwaysEnabled: plugin.manifest.alwaysEnabled,
    guildId: interaction.guildId,
  });
  if (!gateOk) return;

  const guildConfig = await host.configStore.getGuildConfig(interaction.guildId);
  const staffLevel = resolveInteractionStaffLevel({
    member: interaction.member,
    guildOwnerId: interaction.guild.ownerId,
    botOwnerIds: host.botOwnerIds,
    staffRoles: {
      adminRoleIds: guildConfig.adminRoleIds,
      modRoleIds: guildConfig.modRoleIds,
      helperRoleIds: guildConfig.helperRoleIds,
    },
  });

  const channel = interaction.channel && 'guild' in interaction.channel ? interaction.channel : null;
  const proceed = await checkAndConsume({
    interaction: repliable,
    host,
    logger,
    t,
    requirement: command.requirement,
    staffLevel,
    actorPermissionsBitfield: interaction.member.permissions.bitfield,
    userId: interaction.user.id,
    guild: interaction.guild,
    channel,
    commandNameForCooldown: interaction.commandName,
    cooldown: command.requirement?.cooldown,
  });
  if (!proceed) return;

  const contextMenuContext: ContextMenuContext = {
    interaction,
    ctx,
    guildId: interaction.guildId,
    staffLevel,
    locale: interaction.locale,
    t,
    config: <T>() => ctx.getConfig<T>(interaction.guildId),
  };

  try {
    await command.executeContextMenu(contextMenuContext);
  } catch (err) {
    await replyError(
      repliable,
      messageForThrown(err, t, logger, { plugin: pluginId, command: interaction.commandName }),
      logger,
    );
  }
}

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  host: LoadedHost,
  logger: Logger,
): Promise<void> {
  const respondEmpty = async () => {
    try {
      await interaction.respond([]);
    } catch {
      // The interaction may already be past its 3s window; nothing to do.
    }
  };

  const entry = host.commands.get(interaction.commandName);
  if (!entry || !interaction.inCachedGuild()) {
    await respondEmpty();
    return;
  }
  const { plugin, command } = entry;
  if (!command.autocomplete) {
    await respondEmpty();
    return;
  }
  const ctx = host.contexts.get(plugin.manifest.id);
  if (!ctx) {
    await respondEmpty();
    return;
  }
  const t = boundTFor(ctx, interaction.locale);

  // Gate autocomplete the same way commands, context menus and components are gated: a disabled or unavailable
  // plugin must not run its handler or reach the database. Autocomplete cannot carry an explanation, so an
  // empty suggestion list is the whole response.
  const gateFailure = await pluginGateFailure({
    host,
    t,
    pluginId: plugin.manifest.id,
    pluginName: plugin.manifest.name,
    alwaysEnabled: plugin.manifest.alwaysEnabled,
    guildId: interaction.guildId,
  });
  if (gateFailure) {
    await respondEmpty();
    return;
  }

  const guildConfig = await host.configStore.getGuildConfig(interaction.guildId);
  const staffLevel = resolveInteractionStaffLevel({
    member: interaction.member,
    guildOwnerId: interaction.guild.ownerId,
    botOwnerIds: host.botOwnerIds,
    staffRoles: {
      adminRoleIds: guildConfig.adminRoleIds,
      modRoleIds: guildConfig.modRoleIds,
      helperRoleIds: guildConfig.helperRoleIds,
    },
  });

  const autocompleteContext: AutocompleteContext = {
    interaction,
    ctx,
    guildId: interaction.guildId,
    staffLevel,
    locale: interaction.locale,
    t,
    config: <T>() => ctx.getConfig<T>(interaction.guildId),
  };

  try {
    await command.autocomplete(autocompleteContext);
  } catch (err) {
    logger.error(
      { plugin: plugin.manifest.id, command: interaction.commandName, err },
      'autocomplete handler threw',
    );
    await respondEmpty();
  }
}

type AnyComponentInteraction = ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction;

function componentKindOf(interaction: AnyComponentInteraction): 'button' | 'select' | 'modal' {
  if (interaction.isButton()) return 'button';
  if (interaction.isModalSubmit()) return 'modal';
  return 'select';
}

async function handleComponent(
  interaction: AnyComponentInteraction,
  host: LoadedHost,
  logger: Logger,
): Promise<void> {
  const parsed = parseCustomId(interaction.customId);

  // The shared pagination row (`sdk/pagination.ts`) belongs to no plugin — its pages live in the SDK's session
  // map — so there is nothing in `host.components` to find and the host answers the reserved `page` action
  // itself. Handled before the requirement pipeline below because flipping a page is a pure in-memory
  // re-render: it must not wait on `getGuildConfig`/Redis, nor be refused by the global limiter, to stay
  // inside Discord's 3s acknowledgement window.
  if (parsed.action === PAGINATION_ACTION) {
    if (!interaction.isButton()) {
      await replyError(interaction, coreT('errors.not_found', { thing: 'Interaction' }), logger);
      return;
    }
    try {
      await handlePaginationInteraction(interaction);
    } catch (err) {
      logger.error({ customId: interaction.customId, err }, 'router: pagination handler threw');
      await replyError(interaction, coreT('errors.generic'), logger);
    }
    return;
  }

  const entry = host.components.get(`${parsed.pluginId}:${parsed.action}`);

  if (!entry || entry.handler.kind !== componentKindOf(interaction)) {
    await replyError(interaction, coreT('errors.not_found', { thing: 'Interaction' }), logger);
    return;
  }
  const { plugin, handler } = entry;
  const pluginId = plugin.manifest.id;

  if (!interaction.inCachedGuild()) {
    await replyError(interaction, coreT('errors.guild_only'), logger);
    return;
  }

  const ctx = host.contexts.get(pluginId);
  if (!ctx) {
    await replyError(interaction, coreT('errors.generic'), logger);
    return;
  }
  const t = boundTFor(ctx, interaction.locale);

  const ownerOnly = handler.ownerOnly ?? true;
  if (ownerOnly) {
    const ownerId = parsed.args[0];
    if (!ownerId || ownerId !== interaction.user.id) {
      await replyError(interaction, t('errors.permission_denied'), logger);
      return;
    }
  }

  const gateOk = await checkPluginGate({
    interaction,
    host,
    logger,
    t,
    pluginId,
    pluginName: plugin.manifest.name,
    alwaysEnabled: plugin.manifest.alwaysEnabled,
    guildId: interaction.guildId,
  });
  if (!gateOk) return;

  const guildConfig = await host.configStore.getGuildConfig(interaction.guildId);
  const staffLevel = resolveInteractionStaffLevel({
    member: interaction.member,
    guildOwnerId: interaction.guild.ownerId,
    botOwnerIds: host.botOwnerIds,
    staffRoles: {
      adminRoleIds: guildConfig.adminRoleIds,
      modRoleIds: guildConfig.modRoleIds,
      helperRoleIds: guildConfig.helperRoleIds,
    },
  });

  const channel = interaction.channel && 'guild' in interaction.channel ? interaction.channel : null;
  const proceed = await checkAndConsume({
    interaction,
    host,
    logger,
    t,
    requirement: handler.requirement,
    staffLevel,
    actorPermissionsBitfield: interaction.member.permissions.bitfield,
    userId: interaction.user.id,
    guild: interaction.guild,
    channel,
  });
  if (!proceed) return;

  const componentContext: ComponentContext = {
    // Component custom-id routing is checked against `handler.kind` above, but the three interaction subtypes
    // (button/select/modal) don't structurally unify under a single discord.js type — same pattern as
    // sdk/confirm.ts and admin/components/wizard.ts, which cast through `unknown` for the same reason.
    interaction: interaction as unknown as ComponentContext['interaction'],
    ctx,
    guildId: interaction.guildId,
    staffLevel,
    locale: interaction.locale,
    t,
    config: <T>() => ctx.getConfig<T>(interaction.guildId),
    args: parsed.args,
  };

  try {
    await handler.handler(componentContext);
  } catch (err) {
    await replyError(
      interaction,
      messageForThrown(err, t, logger, { plugin: pluginId, action: parsed.action }),
      logger,
    );
  }
}
