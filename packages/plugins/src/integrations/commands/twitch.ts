import { randomBytes } from 'node:crypto';
import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  Prisma,
  type TwitchChatChannel,
  type TwitchChatLevel as PrismaTwitchChatLevel,
  type TwitchRewardActionKind as PrismaTwitchRewardActionKind,
} from '@pavisie/database';
import {
  TWITCH_CHAT_LEVELS,
  TWITCH_CHAT_RESERVED_COMMAND_NAMES,
  TWITCH_REWARD_ACTION_KINDS,
  type TwitchChatLevelId,
  type TwitchRewardActionKindId,
} from '@pavisie/types/integrations';
import { SsrfError, assertPublicHttpUrl, decryptSecret, encryptSecret, redisKey } from '@pavisie/core';
import {
  assertStaffLevel,
  brandEmbed,
  errorEmbed,
  listEmbed,
  registerConfirmHandlers,
  requestConfirmation,
  successEmbed,
  type ComponentHandler,
  type PluginCommand,
  type PluginContext,
  type TFunction,
} from '../../sdk';
// Channel-point rewards (channel-points spec v1) reach into twitch-chat/ for the same two helpers the runtime
// itself uses: `listCustomRewards` (autocomplete picks from the broadcaster's real Twitch rewards) and
// `TWITCH_REDEMPTIONS_SCOPE` (so `/twitch status` can explain a missing-scope channel with the same string the
// manager's reconcile does, never a hand-copied duplicate).
import { listCustomRewards } from '../twitch-chat/helix';
import { TWITCH_REDEMPTIONS_SCOPE } from '../twitch-chat/broadcaster-token';

// Per-channel limits + name/response/interval bounds mirror apps/api/src/lib/integrations/twitch-chat-schemas.ts
// exactly (this command can't import from apps/api — see that file's header comment).
const TWITCH_CHAT_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
const TWITCH_CHAT_MAX_COMMANDS_PER_CHANNEL = 50;
const TWITCH_CHAT_MAX_TIMERS_PER_CHANNEL = 10;
// Mirrors apps/api/src/lib/integrations/twitch-chat-schemas.ts's TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL exactly —
// this package can't import from apps/api (see that file's header comment), same duplication convention as
// the two caps above.
const TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL = 25;

const TWITCH_CHAT_LEVEL_LABEL: Record<TwitchChatLevelId, string> = {
  everyone: 'Everyone',
  subscriber: 'Subscriber',
  vip: 'VIP',
  moderator: 'Moderator',
  broadcaster: 'Broadcaster',
};

const TWITCH_CHAT_LEVEL_CHOICES = TWITCH_CHAT_LEVELS.map((id) => ({
  name: TWITCH_CHAT_LEVEL_LABEL[id],
  value: id,
}));

/** Input level id -> Prisma enum, for writes (mirrors routes/twitch-chat.ts's TWITCH_CHAT_LEVEL_ENUM_MAP). */
const TWITCH_CHAT_LEVEL_ENUM_MAP: Record<TwitchChatLevelId, PrismaTwitchChatLevel> = {
  everyone: 'EVERYONE',
  subscriber: 'SUBSCRIBER',
  vip: 'VIP',
  moderator: 'MODERATOR',
  broadcaster: 'BROADCASTER',
};

/** Reverse of the map above, for display (mirrors lib/integrations/dto.ts's TWITCH_CHAT_LEVEL_MAP). */
const TWITCH_CHAT_LEVEL_FROM_ENUM: Record<PrismaTwitchChatLevel, TwitchChatLevelId> = {
  EVERYONE: 'everyone',
  SUBSCRIBER: 'subscriber',
  VIP: 'vip',
  MODERATOR: 'moderator',
  BROADCASTER: 'broadcaster',
};

const TWITCH_REWARD_ACTION_LABEL: Record<TwitchRewardActionKindId, string> = {
  sound: 'Sound effect',
  tts: 'Text-to-speech',
  chat: 'Chat message',
  discord: 'Discord post',
};

const TWITCH_REWARD_ACTION_CHOICES = TWITCH_REWARD_ACTION_KINDS.map((id) => ({
  name: TWITCH_REWARD_ACTION_LABEL[id],
  value: id,
}));

/** Input action id -> Prisma enum, for writes. */
const TWITCH_REWARD_ACTION_ENUM_MAP: Record<TwitchRewardActionKindId, PrismaTwitchRewardActionKind> = {
  sound: 'SOUND',
  tts: 'TTS',
  chat: 'CHAT',
  discord: 'DISCORD',
};

/** Reverse of the map above, for display. */
const TWITCH_REWARD_ACTION_FROM_ENUM: Record<PrismaTwitchRewardActionKind, TwitchRewardActionKindId> = {
  SOUND: 'sound',
  TTS: 'tts',
  CHAT: 'chat',
  DISCORD: 'discord',
};

/** True for Prisma's unique-constraint-violation error (P2002) — same check as routes/twitch-chat.ts's isUniqueViolation. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function statusLabel(status: string): string {
  return (
    { CONNECTED: '🟢 Connected', DISCONNECTED: '⚪ Disconnected', ERROR: '🔴 Error', PENDING: '🟡 Pending' }[
      status
    ] ?? status
  );
}

/** Fire-and-forget: nudges the running `TwitchChatManager` to pick up a command/timer/channel change now instead
 * of waiting for the next `twitch-chat-tick` job (up to a minute later). Never blocks the command reply, and a
 * failure here is just logged — the next scheduled tick still catches up regardless. */
function nudgeReconcile(ctx: PluginContext): void {
  const service = ctx.services.get('twitchChat');
  if (!service) return;
  void service.reconcileNow().catch((err: unknown) => {
    ctx.logger.error({ err }, 'integrations/twitch: reconcile-after-command-change failed');
  });
}

const data = new SlashCommandBuilder()
  .setName('twitch')
  .setDescription("Manage Pavisie joining this server's Twitch chat.")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) => sub.setName('status').setDescription('Show Twitch chat bot status for this server.'))
  .addSubcommand((sub) =>
    sub.setName('setup').setDescription('How to connect a Twitch channel from the dashboard.'),
  )
  .addSubcommand((sub) =>
    sub.setName('off').setDescription('Turn off Twitch chat for every linked channel here.'),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('command')
      .setDescription('Manage custom Twitch chat commands.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a custom !command.')
          .addStringOption((opt) =>
            opt
              .setName('name')
              .setDescription('Command name (letters, numbers, underscore; no !)')
              .setRequired(true)
              .setMaxLength(32),
          )
          .addStringOption((opt) =>
            opt
              .setName('response')
              .setDescription('Reply text. Use {user} and {channel} as placeholders.')
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(400),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('cooldown')
              .setDescription('Cooldown in seconds (default 5)')
              .setRequired(false)
              .setMinValue(0)
              .setMaxValue(3600),
          )
          .addStringOption((opt) =>
            opt
              .setName('level')
              .setDescription('Minimum chat privilege required (default everyone)')
              .setRequired(false)
              .addChoices(...TWITCH_CHAT_LEVEL_CHOICES),
          )
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a custom command.')
          .addStringOption((opt) => opt.setName('name').setDescription('Command name').setRequired(true))
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List custom commands.')
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('timer')
      .setDescription('Manage recurring auto-posted Twitch chat messages.')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a recurring timer message.')
          .addStringOption((opt) =>
            opt
              .setName('name')
              .setDescription('Timer name (letters, numbers, underscore)')
              .setRequired(true)
              .setMaxLength(32),
          )
          .addStringOption((opt) =>
            opt
              .setName('message')
              .setDescription('Message to post')
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(400),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('interval-minutes')
              .setDescription('How often to post, in minutes (5-1440)')
              .setRequired(true)
              .setMinValue(5)
              .setMaxValue(1440),
          )
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a timer.')
          .addStringOption((opt) => opt.setName('name').setDescription('Timer name').setRequired(true))
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List timers.')
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('reward')
      .setDescription('Manage channel-point reward actions (sound/TTS/chat/Discord).')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a channel-point reward action.')
          .addStringOption((opt) =>
            opt
              .setName('reward-title')
              .setDescription("The Twitch custom reward's exact title")
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(100)
              .setAutocomplete(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('action')
              .setDescription('What redeeming it does')
              .setRequired(true)
              .addChoices(...TWITCH_REWARD_ACTION_CHOICES),
          )
          .addStringOption((opt) =>
            opt
              .setName('sound-url')
              .setDescription('Public https:// URL to play (sound effect action only)')
              .setRequired(false)
              .setMaxLength(500),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('volume')
              .setDescription('Playback volume 0-100 (sound effect action only; default 80)')
              .setRequired(false)
              .setMinValue(0)
              .setMaxValue(100),
          )
          .addStringOption((opt) =>
            opt
              .setName('text')
              .setDescription(
                'Text template — {user}/{input}/{reward} placeholders (TTS/chat/Discord actions only)',
              )
              .setRequired(false)
              .setMinLength(1)
              .setMaxLength(300),
          )
          .addChannelOption((opt) =>
            opt
              .setName('discord-channel')
              .setDescription('Discord channel to post in (Discord action only)')
              .setRequired(false)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('cooldown')
              .setDescription('Per-reward cooldown in seconds (default 0)')
              .setRequired(false)
              .setMinValue(0)
              .setMaxValue(3600),
          )
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a channel-point reward action.')
          .addStringOption((opt) =>
            opt
              .setName('reward-title')
              .setDescription('Reward title')
              .setRequired(true)
              .setAutocomplete(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List channel-point reward actions.')
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('enable')
          .setDescription('Turn on channel-point rewards for a channel.')
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('disable')
          .setDescription('Turn off channel-point rewards for a channel.')
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('overlay')
          .setDescription('Get the OBS browser-source URL for channel-point alerts.')
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('overlay-reset')
          .setDescription('Regenerate the OBS overlay URL (invalidates the previous one).')
          .addStringOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Twitch channel (only needed if more than one is linked)')
              .setRequired(false)
              .setAutocomplete(true),
          ),
      ),
  );

type ChannelLookupResult = { ok: true; channel: TwitchChatChannel } | { ok: false; message: string };

/** Resolves the `channel` string option (a Twitch broadcaster login, NOT a Discord channel) against this guild's
 * linked `TwitchChatChannel` rows. The option may be omitted only when the guild has exactly one linked channel. */
async function resolveChannel(c: Parameters<PluginCommand['execute']>[0]): Promise<ChannelLookupResult> {
  const requested = c.interaction.options.getString('channel');
  const channels = await c.ctx.prisma.twitchChatChannel.findMany({ where: { guildId: c.guildId } });

  if (requested) {
    const normalized = requested.trim().toLowerCase();
    const match = channels.find((ch) => ch.broadcasterLogin.toLowerCase() === normalized);
    if (!match) return { ok: false, message: c.t('twitch.errors.channelNotFound', { channel: requested }) };
    return { ok: true, channel: match };
  }

  if (channels.length === 0) return { ok: false, message: c.t('twitch.errors.noChannels') };
  if (channels.length > 1) return { ok: false, message: c.t('twitch.errors.channelRequired') };
  return { ok: true, channel: channels[0]! };
}

async function disableAllTwitchChatChannels(ctx: PluginContext, guildId: string, actorId: string): Promise<void> {
  await ctx.prisma.twitchChatChannel.updateMany({ where: { guildId }, data: { enabled: false } });
  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: 'integration.twitch_chat.disable_all',
    targetType: 'twitch_chat_channel',
    source: 'bot',
  });
  nudgeReconcile(ctx);
}

async function deleteTwitchChatCommand(
  ctx: PluginContext,
  guildId: string,
  actorId: string,
  commandId: string,
  name: string,
): Promise<void> {
  await ctx.prisma.twitchChatCommand.delete({ where: { id: commandId } });
  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: 'integration.twitch_chat.command.delete',
    targetType: 'twitch_chat_command',
    targetId: commandId,
    before: { name },
    source: 'bot',
  });
  nudgeReconcile(ctx);
}

async function deleteTwitchChatTimer(
  ctx: PluginContext,
  guildId: string,
  actorId: string,
  timerId: string,
  name: string,
): Promise<void> {
  await ctx.prisma.twitchChatTimer.delete({ where: { id: timerId } });
  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: 'integration.twitch_chat.timer.delete',
    targetType: 'twitch_chat_timer',
    targetId: timerId,
    before: { name },
    source: 'bot',
  });
  nudgeReconcile(ctx);
}

async function deleteTwitchChatReward(
  ctx: PluginContext,
  guildId: string,
  actorId: string,
  rewardId: string,
  rewardTitle: string,
): Promise<void> {
  await ctx.prisma.twitchChatReward.delete({ where: { id: rewardId } });
  await ctx.audit({
    guildId,
    actorId,
    actorType: 'user',
    action: 'integration.twitch_chat.reward.delete',
    targetType: 'twitch_chat_reward',
    targetId: rewardId,
    before: { rewardTitle },
    source: 'bot',
  });
  nudgeReconcile(ctx);
}

/** Channel-point rewards line for `/twitch status` (channel-points spec v1): reports off/on, whether the
 * overlay browser-source URL has been generated, and — the case that must never be silent — a channel with
 * rewards turned on whose stored broadcaster token lacks `channel:read:redemptions` (never linked with the
 * scope, or the connection was replaced by a plain chat re-link). `token` is the channel's `OAuthToken` row
 * (via `connectionId`), or `null` when there is no connection/token at all — treated the same as missing scope. */
function rewardsStatusLabel(
  c: Parameters<PluginCommand['execute']>[0],
  channel: TwitchChatChannel,
  token: { scopes: string[] } | null,
): string {
  if (!channel.rewardsEnabled) return c.t('twitch.status.rewardsDisabled');
  if (!token?.scopes.includes(TWITCH_REDEMPTIONS_SCOPE)) return c.t('twitch.status.rewardsRelinkRequired');
  return channel.overlayTokenEnc
    ? c.t('twitch.status.rewardsEnabledOverlayReady')
    : c.t('twitch.status.rewardsEnabledNoOverlay');
}

async function handleStatus(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const [botIdentity, channels] = await Promise.all([
    c.ctx.prisma.twitchBotIdentity.findFirst(),
    c.ctx.prisma.twitchChatChannel.findMany({ where: { guildId: c.guildId }, orderBy: { createdAt: 'asc' } }),
  ]);

  const counts = await Promise.all(
    channels.map((channel) =>
      Promise.all([
        c.ctx.prisma.twitchChatCommand.count({ where: { channelId: channel.id } }),
        c.ctx.prisma.twitchChatTimer.count({ where: { channelId: channel.id } }),
      ]),
    ),
  );
  // Only fetched for channels with rewards turned on — the common case (rewards off) needs no OAuthToken
  // lookup at all, and `rewardsStatusLabel` treats a `null` token the same as a missing-scope one.
  const oauthTokens = await Promise.all(
    channels.map((channel) =>
      channel.rewardsEnabled && channel.connectionId
        ? c.ctx.prisma.oAuthToken.findUnique({ where: { connectionId: channel.connectionId } })
        : Promise.resolve(null),
    ),
  );

  const runtime = c.ctx.services.get('twitchChat')?.status();

  const lines: string[] = [];
  lines.push(
    botIdentity
      ? c.t('twitch.status.botConfigured', { login: botIdentity.botLogin })
      : c.t('twitch.status.botNotConfigured'),
  );
  if (runtime) {
    lines.push(
      !runtime.enabled
        ? c.t('twitch.status.runtimeIdle', { reason: runtime.reason ?? 'Not configured.' })
        : runtime.connected
          ? c.t('twitch.status.runtimeConnected', { count: runtime.joinedChannels })
          : c.t('twitch.status.runtimeReconnecting', { reason: runtime.lastError ?? 'Reconnecting…' }),
    );
  }

  if (channels.length === 0) {
    lines.push(c.t('twitch.status.noChannels'));
  } else {
    channels.forEach((channel, i) => {
      const [commandCount, timerCount] = counts[i]!;
      lines.push(
        c.t('twitch.status.channelLine', {
          status: statusLabel(channel.status),
          login: channel.broadcasterLogin,
          prefix: channel.commandPrefix,
          commands: commandCount,
          timers: timerCount,
          disabled: channel.enabled ? '' : c.t('twitch.status.channelDisabledSuffix'),
        }),
      );
      lines.push(
        c.t('twitch.status.rewardsLine', { state: rewardsStatusLabel(c, channel, oauthTokens[i] ?? null) }),
      );
    });
  }

  await c.interaction.reply({ embeds: [listEmbed(c.t('twitch.status.title'), lines)], ephemeral: true });
}

async function handleSetup(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const botIdentity = await c.ctx.prisma.twitchBotIdentity.findFirst();
  const dashboardUrl = c.ctx.env.DASHBOARD_URL ?? 'the dashboard';
  const url = `${dashboardUrl}/dashboard/${c.guildId}/integrations`;

  const body =
    c.t('twitch.setup.instructions', { url }) +
    c.t('twitch.setup.rewardsInstructions') +
    (botIdentity ? '' : c.t('twitch.setup.botNotConfiguredNote'));

  await c.interaction.reply({ embeds: [brandEmbed().setDescription(body)], ephemeral: true });
}

async function handleOff(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const channels = await c.ctx.prisma.twitchChatChannel.findMany({ where: { guildId: c.guildId } });
  if (channels.length === 0) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('twitch.off.noChannels'))], ephemeral: true });
    return;
  }

  const host = c.ctx.services.get('host');
  const guildConfig = host ? await host.getGuildConfig(c.guildId).catch(() => null) : null;

  const result = await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'integrations',
    action: 'twitch-off',
    ownerId: c.interaction.user.id,
    embed: brandEmbed()
      .setTitle(c.t('twitch.off.confirmTitle'))
      .setDescription(c.t('twitch.off.confirmBody')),
    payload: {},
    fastActions: Boolean(guildConfig?.fastActions),
  });

  if (result.confirmed) {
    // `fastActions` short-circuited requestConfirmation without sending any reply — this is the first reply.
    await disableAllTwitchChatChannels(c.ctx, c.guildId, c.interaction.user.id);
    await c.interaction.reply({ embeds: [successEmbed(c.t('twitch.off.done'))], ephemeral: true });
  }
}

async function handleCommandAdd(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const name = c.interaction.options.getString('name', true).trim().toLowerCase();
  const response = c.interaction.options.getString('response', true).trim();
  const cooldownSeconds = c.interaction.options.getInteger('cooldown') ?? 5;
  const levelId = (c.interaction.options.getString('level') ?? 'everyone') as TwitchChatLevelId;

  if (!TWITCH_CHAT_NAME_PATTERN.test(name)) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('twitch.errors.invalidName'))], ephemeral: true });
    return;
  }
  if ((TWITCH_CHAT_RESERVED_COMMAND_NAMES as readonly string[]).includes(name)) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('twitch.errors.reservedName', { name }))],
      ephemeral: true,
    });
    return;
  }
  if (response.length === 0) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('twitch.errors.emptyResponse'))], ephemeral: true });
    return;
  }

  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  const clash = await c.ctx.prisma.twitchChatCommand.findUnique({
    where: { channelId_name: { channelId: channel.id, name } },
  });
  if (clash) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('twitch.errors.commandExists', { name }))],
      ephemeral: true,
    });
    return;
  }

  const count = await c.ctx.prisma.twitchChatCommand.count({ where: { channelId: channel.id } });
  if (count >= TWITCH_CHAT_MAX_COMMANDS_PER_CHANNEL) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('twitch.errors.commandLimit', { max: TWITCH_CHAT_MAX_COMMANDS_PER_CHANNEL }))],
      ephemeral: true,
    });
    return;
  }

  // The checks above are a friendly fast path, not the real guarantee — the DB's unique constraint
  // (`@@unique([channelId, name])`) is the actual guard against a concurrent create for the same name
  // (precedent: routes/twitch-chat.ts's command create).
  let row;
  try {
    row = await c.ctx.prisma.twitchChatCommand.create({
      data: {
        channelId: channel.id,
        guildId: c.guildId,
        name,
        response,
        cooldownSeconds,
        minLevel: TWITCH_CHAT_LEVEL_ENUM_MAP[levelId],
        createdBy: c.interaction.user.id,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      await c.interaction.reply({
        embeds: [errorEmbed(c.t('twitch.errors.commandExists', { name }))],
        ephemeral: true,
      });
      return;
    }
    throw err;
  }

  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: 'integration.twitch_chat.command.create',
    targetType: 'twitch_chat_command',
    targetId: row.id,
    after: { channelId: channel.id, name: row.name },
    source: 'bot',
  });
  nudgeReconcile(c.ctx);

  await c.interaction.reply({
    embeds: [successEmbed(c.t('twitch.command.added', { name, channel: channel.broadcasterLogin }))],
    ephemeral: true,
  });
}

async function handleCommandRemove(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const name = c.interaction.options.getString('name', true).trim().toLowerCase();

  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  const existing = await c.ctx.prisma.twitchChatCommand.findUnique({
    where: { channelId_name: { channelId: channel.id, name } },
  });
  if (!existing) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('twitch.errors.commandNotFound', { name }))],
      ephemeral: true,
    });
    return;
  }

  const host = c.ctx.services.get('host');
  const guildConfig = host ? await host.getGuildConfig(c.guildId).catch(() => null) : null;

  const result = await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'integrations',
    action: 'twitch-command-remove',
    ownerId: c.interaction.user.id,
    embed: brandEmbed()
      .setTitle(c.t('twitch.command.removeConfirmTitle', { name }))
      .setDescription(c.t('twitch.command.removeConfirmBody', { name, channel: channel.broadcasterLogin })),
    payload: { commandId: existing.id, name },
    fastActions: Boolean(guildConfig?.fastActions),
  });

  if (result.confirmed) {
    await deleteTwitchChatCommand(c.ctx, c.guildId, c.interaction.user.id, existing.id, name);
    await c.interaction.reply({ embeds: [successEmbed(c.t('twitch.command.removed', { name }))], ephemeral: true });
  }
}

async function handleCommandList(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  const rows = await c.ctx.prisma.twitchChatCommand.findMany({
    where: { channelId: channel.id },
    orderBy: { name: 'asc' },
  });
  const lines = rows.map((row) =>
    c.t('twitch.command.listLine', {
      name: row.name,
      level: TWITCH_CHAT_LEVEL_LABEL[TWITCH_CHAT_LEVEL_FROM_ENUM[row.minLevel]],
      cooldown: row.cooldownSeconds,
      disabled: row.enabled ? '' : c.t('twitch.status.channelDisabledSuffix'),
      response: row.response,
    }),
  );

  await c.interaction.reply({
    embeds: [
      listEmbed(
        c.t('twitch.command.listTitle', { channel: channel.broadcasterLogin }),
        lines.length > 0 ? lines : [c.t('twitch.command.listEmpty')],
      ),
    ],
    ephemeral: true,
  });
}

async function handleTimerAdd(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const name = c.interaction.options.getString('name', true).trim().toLowerCase();
  const message = c.interaction.options.getString('message', true).trim();
  const intervalMinutes = c.interaction.options.getInteger('interval-minutes', true);

  if (!TWITCH_CHAT_NAME_PATTERN.test(name)) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('twitch.errors.invalidName'))], ephemeral: true });
    return;
  }
  if (message.length === 0) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('twitch.errors.emptyResponse'))], ephemeral: true });
    return;
  }

  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  const clash = await c.ctx.prisma.twitchChatTimer.findUnique({
    where: { channelId_name: { channelId: channel.id, name } },
  });
  if (clash) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('twitch.errors.timerExists', { name }))],
      ephemeral: true,
    });
    return;
  }

  const count = await c.ctx.prisma.twitchChatTimer.count({ where: { channelId: channel.id } });
  if (count >= TWITCH_CHAT_MAX_TIMERS_PER_CHANNEL) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('twitch.errors.timerLimit', { max: TWITCH_CHAT_MAX_TIMERS_PER_CHANNEL }))],
      ephemeral: true,
    });
    return;
  }

  let row;
  try {
    row = await c.ctx.prisma.twitchChatTimer.create({
      data: {
        channelId: channel.id,
        guildId: c.guildId,
        name,
        message,
        intervalMinutes,
        createdBy: c.interaction.user.id,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      await c.interaction.reply({
        embeds: [errorEmbed(c.t('twitch.errors.timerExists', { name }))],
        ephemeral: true,
      });
      return;
    }
    throw err;
  }

  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: 'integration.twitch_chat.timer.create',
    targetType: 'twitch_chat_timer',
    targetId: row.id,
    after: { channelId: channel.id, name: row.name },
    source: 'bot',
  });
  nudgeReconcile(c.ctx);

  await c.interaction.reply({
    embeds: [
      successEmbed(
        c.t('twitch.timer.added', { name, channel: channel.broadcasterLogin, interval: intervalMinutes }),
      ),
    ],
    ephemeral: true,
  });
}

async function handleTimerRemove(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const name = c.interaction.options.getString('name', true).trim().toLowerCase();

  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  const existing = await c.ctx.prisma.twitchChatTimer.findUnique({
    where: { channelId_name: { channelId: channel.id, name } },
  });
  if (!existing) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('twitch.errors.timerNotFound', { name }))],
      ephemeral: true,
    });
    return;
  }

  const host = c.ctx.services.get('host');
  const guildConfig = host ? await host.getGuildConfig(c.guildId).catch(() => null) : null;

  const result = await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'integrations',
    action: 'twitch-timer-remove',
    ownerId: c.interaction.user.id,
    embed: brandEmbed()
      .setTitle(c.t('twitch.timer.removeConfirmTitle', { name }))
      .setDescription(c.t('twitch.timer.removeConfirmBody', { name, channel: channel.broadcasterLogin })),
    payload: { timerId: existing.id, name },
    fastActions: Boolean(guildConfig?.fastActions),
  });

  if (result.confirmed) {
    await deleteTwitchChatTimer(c.ctx, c.guildId, c.interaction.user.id, existing.id, name);
    await c.interaction.reply({ embeds: [successEmbed(c.t('twitch.timer.removed', { name }))], ephemeral: true });
  }
}

async function handleTimerList(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  const rows = await c.ctx.prisma.twitchChatTimer.findMany({
    where: { channelId: channel.id },
    orderBy: { name: 'asc' },
  });
  const lines = rows.map((row) =>
    c.t('twitch.timer.listLine', {
      name: row.name,
      interval: row.intervalMinutes,
      disabled: row.enabled ? '' : c.t('twitch.status.channelDisabledSuffix'),
      message: row.message,
    }),
  );

  await c.interaction.reply({
    embeds: [
      listEmbed(
        c.t('twitch.timer.listTitle', { channel: channel.broadcasterLogin }),
        lines.length > 0 ? lines : [c.t('twitch.timer.listEmpty')],
      ),
    ],
    ephemeral: true,
  });
}

interface RewardFieldsInput {
  soundUrl: string | null;
  volume: number | null;
  text: string | null;
  discordChannelId: string | null;
}

/** Cross-field validation for `/twitch reward add`, mirroring
 * apps/api/src/lib/integrations/twitch-chat-schemas.ts's `validateRewardActionFields`: every field required by
 * the chosen `action` must be present, and every field belonging to a *different* action must be absent. The
 * API validates three separate template fields (ttsTemplate/chatTemplate/discordTemplate); this command
 * collapses them into one `text` option (see the builder above), so field names differ, but the
 * required/disallowed shape is the same rule set. Returns the first violation found, or `null` when valid. */
function validateRewardFields(action: TwitchRewardActionKindId, input: RewardFieldsInput, t: TFunction): string | null {
  const label = TWITCH_REWARD_ACTION_LABEL[action];

  const disallowed: [boolean, string][] = [
    [action !== 'sound' && input.soundUrl !== null, 'sound-url'],
    [action !== 'sound' && input.volume !== null, 'volume'],
    [action === 'sound' && input.text !== null, 'text'],
    [action !== 'discord' && input.discordChannelId !== null, 'discord-channel'],
  ];
  for (const [present, field] of disallowed) {
    if (present) return t('twitch.errors.rewardFieldNotAllowed', { field, action: label });
  }

  if (action === 'sound' && !input.soundUrl) {
    return t('twitch.errors.rewardFieldRequired', { field: 'sound-url', action: label });
  }
  if ((action === 'tts' || action === 'chat') && !input.text) {
    return t('twitch.errors.rewardFieldRequired', { field: 'text', action: label });
  }
  if (action === 'discord') {
    if (!input.discordChannelId) return t('twitch.errors.rewardFieldRequired', { field: 'discord-channel', action: label });
    if (!input.text) return t('twitch.errors.rewardFieldRequired', { field: 'text', action: label });
  }

  return null;
}

async function handleRewardAdd(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const rewardTitle = c.interaction.options.getString('reward-title', true).trim();
  const actionId = c.interaction.options.getString('action', true) as TwitchRewardActionKindId;
  const soundUrl = c.interaction.options.getString('sound-url')?.trim() || null;
  const volume = c.interaction.options.getInteger('volume');
  const text = c.interaction.options.getString('text')?.trim() || null;
  const discordChannel = c.interaction.options.getChannel('discord-channel');
  const cooldownSeconds = c.interaction.options.getInteger('cooldown') ?? 0;

  if (rewardTitle.length === 0) {
    await c.interaction.reply({ embeds: [errorEmbed(c.t('twitch.errors.emptyResponse'))], ephemeral: true });
    return;
  }

  const fieldError = validateRewardFields(
    actionId,
    { soundUrl, volume, text, discordChannelId: discordChannel?.id ?? null },
    c.t,
  );
  if (fieldError) {
    await c.interaction.reply({ embeds: [errorEmbed(fieldError)], ephemeral: true });
    return;
  }

  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  const action = TWITCH_REWARD_ACTION_ENUM_MAP[actionId];

  const clash = await c.ctx.prisma.twitchChatReward.findFirst({
    where: { channelId: channel.id, action, rewardTitle: { equals: rewardTitle, mode: 'insensitive' } },
  });
  if (clash) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('twitch.errors.rewardExists', { name: rewardTitle }))],
      ephemeral: true,
    });
    return;
  }

  const count = await c.ctx.prisma.twitchChatReward.count({ where: { channelId: channel.id } });
  if (count >= TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('twitch.errors.rewardLimit', { max: TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL }))],
      ephemeral: true,
    });
    return;
  }

  // SOUND only, and only once every earlier (cheap, no-network) check has passed — a live DNS lookup is the
  // most expensive validation here, same ordering rationale as ai/commands/config.ts's base-url check.
  if (soundUrl) {
    try {
      await assertPublicHttpUrl(soundUrl);
    } catch (err) {
      await c.interaction.reply({
        embeds: [
          errorEmbed(
            c.t('errors.invalidUrl', {
              reason: err instanceof SsrfError ? err.message : 'That URL is not allowed.',
            }),
          ),
        ],
        ephemeral: true,
      });
      return;
    }
  }

  // Best-effort: resolve the Twitch reward id for this title so redemption matching (rewards.ts) can key off
  // the stable id rather than a title that could later be renamed. A failed/unavailable lookup (no broadcaster
  // token yet, re-link required, Helix error) just leaves `rewardId` null — the runtime already supports
  // matching redemptions by title alone (channel-points spec v1, binding fact 5's title-fallback) for exactly
  // this case, so this is never fatal to the add.
  let rewardId: string | null = null;
  const twitchRewards = await listCustomRewards(c.ctx, channel);
  if (twitchRewards.ok) {
    const match = twitchRewards.value.find((r) => r.title.toLowerCase() === rewardTitle.toLowerCase());
    if (match) rewardId = match.id;
  }

  let row;
  try {
    row = await c.ctx.prisma.twitchChatReward.create({
      data: {
        channelId: channel.id,
        guildId: c.guildId,
        rewardId,
        rewardTitle,
        action,
        soundUrl: action === 'SOUND' ? soundUrl : null,
        volume: action === 'SOUND' ? (volume ?? 80) : 80,
        ttsTemplate: action === 'TTS' ? text : null,
        chatTemplate: action === 'CHAT' ? text : null,
        discordChannelId: action === 'DISCORD' ? (discordChannel?.id ?? null) : null,
        discordTemplate: action === 'DISCORD' ? text : null,
        cooldownSeconds,
        createdBy: c.interaction.user.id,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      await c.interaction.reply({
        embeds: [errorEmbed(c.t('twitch.errors.rewardExists', { name: rewardTitle }))],
        ephemeral: true,
      });
      return;
    }
    throw err;
  }

  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: 'integration.twitch_chat.reward.create',
    targetType: 'twitch_chat_reward',
    targetId: row.id,
    after: { channelId: channel.id, rewardTitle: row.rewardTitle, action },
    source: 'bot',
  });
  nudgeReconcile(c.ctx);

  await c.interaction.reply({
    embeds: [
      successEmbed(
        c.t('twitch.reward.added', {
          title: rewardTitle,
          action: TWITCH_REWARD_ACTION_LABEL[actionId],
          channel: channel.broadcasterLogin,
        }),
      ),
    ],
    ephemeral: true,
  });
}

async function handleRewardRemove(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const rewardTitle = c.interaction.options.getString('reward-title', true).trim();

  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  // Unlike command/timer names, `rewardTitle` isn't lowercase-normalized at write time (real Twitch reward
  // titles keep their original casing for display) — the unique constraint is `[channelId, rewardTitle,
  // action]`, so the SAME title can legitimately exist for two different actions. Matching by title alone here
  // (no `action` option in this subcommand, per spec) can therefore find more than one row; that's reported as
  // ambiguous rather than guessing which one the caller meant.
  const matches = await c.ctx.prisma.twitchChatReward.findMany({
    where: { channelId: channel.id, rewardTitle: { equals: rewardTitle, mode: 'insensitive' } },
  });

  if (matches.length === 0) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('twitch.errors.rewardNotFound', { name: rewardTitle }))],
      ephemeral: true,
    });
    return;
  }
  if (matches.length > 1) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('twitch.errors.rewardAmbiguous', { name: rewardTitle }))],
      ephemeral: true,
    });
    return;
  }
  const existing = matches[0]!;

  const host = c.ctx.services.get('host');
  const guildConfig = host ? await host.getGuildConfig(c.guildId).catch(() => null) : null;

  const result = await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'integrations',
    action: 'twitch-reward-remove',
    ownerId: c.interaction.user.id,
    embed: brandEmbed()
      .setTitle(c.t('twitch.reward.removeConfirmTitle', { title: existing.rewardTitle }))
      .setDescription(
        c.t('twitch.reward.removeConfirmBody', { title: existing.rewardTitle, channel: channel.broadcasterLogin }),
      ),
    payload: { rewardId: existing.id, rewardTitle: existing.rewardTitle },
    fastActions: Boolean(guildConfig?.fastActions),
  });

  if (result.confirmed) {
    await deleteTwitchChatReward(c.ctx, c.guildId, c.interaction.user.id, existing.id, existing.rewardTitle);
    await c.interaction.reply({
      embeds: [successEmbed(c.t('twitch.reward.removed', { title: existing.rewardTitle }))],
      ephemeral: true,
    });
  }
}

async function handleRewardList(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  const rows = await c.ctx.prisma.twitchChatReward.findMany({
    where: { channelId: channel.id },
    orderBy: { rewardTitle: 'asc' },
  });
  const lines = rows.map((row) =>
    c.t('twitch.reward.listLine', {
      title: row.rewardTitle,
      action: TWITCH_REWARD_ACTION_LABEL[TWITCH_REWARD_ACTION_FROM_ENUM[row.action]],
      cooldown: row.cooldownSeconds,
      disabled: row.enabled ? '' : c.t('twitch.status.channelDisabledSuffix'),
    }),
  );

  await c.interaction.reply({
    embeds: [
      listEmbed(
        c.t('twitch.reward.listTitle', { channel: channel.broadcasterLogin }),
        lines.length > 0 ? lines : [c.t('twitch.reward.listEmpty')],
      ),
    ],
    ephemeral: true,
  });
}

async function handleRewardEnable(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  await c.ctx.prisma.twitchChatChannel.update({ where: { id: channel.id }, data: { rewardsEnabled: true } });
  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: 'integration.twitch_chat.reward.enable',
    targetType: 'twitch_chat_channel',
    targetId: channel.id,
    after: { rewardsEnabled: true },
    source: 'bot',
  });
  nudgeReconcile(c.ctx);

  // Check if the channel's broadcaster token has the required scope
  const token =
    channel.connectionId && !channel.connectionId.startsWith('_')
      ? await c.ctx.prisma.oAuthToken.findUnique({ where: { connectionId: channel.connectionId } })
      : null;

  const hasScope = token?.scopes.includes(TWITCH_REDEMPTIONS_SCOPE);
  const message = hasScope
    ? c.t('twitch.reward.enabled', { channel: channel.broadcasterLogin })
    : c.t('twitch.reward.enabledRelinkRequired', { channel: channel.broadcasterLogin });

  await c.interaction.reply({
    embeds: [successEmbed(message)],
    ephemeral: true,
  });
}

async function handleRewardDisable(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  await c.ctx.prisma.twitchChatChannel.update({ where: { id: channel.id }, data: { rewardsEnabled: false } });
  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: 'integration.twitch_chat.reward.disable',
    targetType: 'twitch_chat_channel',
    targetId: channel.id,
    after: { rewardsEnabled: false },
    source: 'bot',
  });
  nudgeReconcile(c.ctx);

  await c.interaction.reply({
    embeds: [successEmbed(c.t('twitch.reward.disabled', { channel: channel.broadcasterLogin }))],
    ephemeral: true,
  });
}

async function handleRewardOverlay(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  let token: string;
  let needsAudit = false;

  if (!channel.overlayTokenEnc) {
    // Generate a new token
    token = randomBytes(24).toString('hex');
    await c.ctx.prisma.twitchChatChannel.update({
      where: { id: channel.id },
      data: { overlayTokenEnc: encryptSecret(token) },
    });
    await c.ctx.redis.set(redisKey('overlay', 'token', token), channel.id);
    needsAudit = true;
  } else {
    // Decrypt the existing token
    token = decryptSecret(channel.overlayTokenEnc);
  }

  if (needsAudit) {
    await c.ctx.audit({
      guildId: c.guildId,
      actorId: c.interaction.user.id,
      actorType: 'user',
      action: 'integration.twitch_chat.overlay.generate',
      targetType: 'twitch_chat_channel',
      targetId: channel.id,
      after: { configured: true },
      source: 'bot',
    });
  }

  const apiBaseUrl = c.ctx.env.API_BASE_URL ?? '';
  const url = `${apiBaseUrl}/overlay/${token}`;

  await c.interaction.reply({
    embeds: [
      brandEmbed()
        .setTitle(c.t('twitch.reward.overlayTitle'))
        .setDescription(c.t('twitch.reward.overlayBody', { url, channel: channel.broadcasterLogin })),
    ],
    ephemeral: true,
  });
}

async function handleRewardOverlayReset(c: Parameters<PluginCommand['execute']>[0]): Promise<void> {
  const resolved = await resolveChannel(c);
  if (!resolved.ok) {
    await c.interaction.reply({ embeds: [errorEmbed(resolved.message)], ephemeral: true });
    return;
  }
  const { channel } = resolved;

  const host = c.ctx.services.get('host');
  const guildConfig = host ? await host.getGuildConfig(c.guildId).catch(() => null) : null;

  const result = await requestConfirmation({
    interaction: c.interaction,
    ctx: c.ctx,
    pluginId: 'integrations',
    action: 'twitch-overlay-reset',
    ownerId: c.interaction.user.id,
    embed: brandEmbed()
      .setTitle(c.t('twitch.reward.overlayResetConfirmTitle'))
      .setDescription(c.t('twitch.reward.overlayResetConfirmBody', { channel: channel.broadcasterLogin })),
    payload: { channelId: channel.id },
    fastActions: Boolean(guildConfig?.fastActions),
  });

  if (result.confirmed) {
    // Delete the old token's Redis index if it exists
    if (channel.overlayTokenEnc) {
      try {
        const oldToken = decryptSecret(channel.overlayTokenEnc);
        await c.ctx.redis.del(redisKey('overlay', 'token', oldToken));
      } catch {
        // Ignore decryption failures — orphaned index entries don't affect security
      }
    }

    // Generate a new token
    const token = randomBytes(24).toString('hex');
    await c.ctx.prisma.twitchChatChannel.update({
      where: { id: channel.id },
      data: { overlayTokenEnc: encryptSecret(token) },
    });
    await c.ctx.redis.set(redisKey('overlay', 'token', token), channel.id);

    await c.ctx.audit({
      guildId: c.guildId,
      actorId: c.interaction.user.id,
      actorType: 'user',
      action: 'integration.twitch_chat.overlay.regenerate',
      targetType: 'twitch_chat_channel',
      targetId: channel.id,
      after: { configured: true },
      source: 'bot',
    });

    await c.interaction.reply({
      embeds: [successEmbed(c.t('twitch.reward.overlayResetDone', { channel: channel.broadcasterLogin }))],
      ephemeral: true,
    });
  }
}

export const command: PluginCommand = {
  data,
  requirement: {
    staffLevel: 'admin',
    guildOnly: true,
    discordPermissions: [PermissionFlagsBits.ManageGuild],
  },
  async execute(c) {
    assertStaffLevel(c.staffLevel, 'admin', c.t);
    const group = c.interaction.options.getSubcommandGroup(false);
    const sub = c.interaction.options.getSubcommand(true);

    if (!group) {
      if (sub === 'status') return handleStatus(c);
      if (sub === 'setup') return handleSetup(c);
      if (sub === 'off') return handleOff(c);
    }

    if (group === 'command') {
      if (sub === 'add') return handleCommandAdd(c);
      if (sub === 'remove') return handleCommandRemove(c);
      if (sub === 'list') return handleCommandList(c);
    }

    if (group === 'timer') {
      if (sub === 'add') return handleTimerAdd(c);
      if (sub === 'remove') return handleTimerRemove(c);
      if (sub === 'list') return handleTimerList(c);
    }

    if (group === 'reward') {
      if (sub === 'add') return handleRewardAdd(c);
      if (sub === 'remove') return handleRewardRemove(c);
      if (sub === 'list') return handleRewardList(c);
      if (sub === 'enable') return handleRewardEnable(c);
      if (sub === 'disable') return handleRewardDisable(c);
      if (sub === 'overlay') return handleRewardOverlay(c);
      if (sub === 'overlay-reset') return handleRewardOverlayReset(c);
    }
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    if (focused.name === 'channel') {
      const query = String(focused.value).toLowerCase();
      const channels = await c.ctx.prisma.twitchChatChannel.findMany({
        where: { guildId: c.guildId },
        take: 25,
        orderBy: { createdAt: 'desc' },
      });
      const results = channels
        .filter((ch) => ch.broadcasterLogin.toLowerCase().includes(query))
        .slice(0, 25);
      await c.interaction.respond(
        results.map((ch) => ({ name: ch.broadcasterLogin.slice(0, 100), value: ch.broadcasterLogin })),
      );
      return;
    }

    if (focused.name === 'reward-title') {
      // Never throw out of autocomplete (Discord just shows no suggestions on a failed respond, but an
      // uncaught rejection here would be a silent 500 in the interaction handler) — every path below ends in
      // `respond`, and this outer try/catch is the last-resort backstop for anything unexpected in between.
      try {
        const query = String(focused.value).toLowerCase();
        const channels = await c.ctx.prisma.twitchChatChannel.findMany({ where: { guildId: c.guildId } });
        const requested = c.interaction.options.getString('channel');
        let channel: TwitchChatChannel | undefined;
        if (requested) {
          const normalized = requested.trim().toLowerCase();
          channel = channels.find((ch) => ch.broadcasterLogin.toLowerCase() === normalized);
        } else if (channels.length === 1) {
          channel = channels[0];
        }

        // Ambiguous (no channel picked yet and more than one is linked) or unresolved — can't know which
        // broadcaster's rewards to suggest, so offer nothing rather than guessing.
        if (!channel) {
          await c.interaction.respond([]);
          return;
        }

        const twitchRewards = await listCustomRewards(c.ctx, channel);
        if (twitchRewards.ok) {
          const results = twitchRewards.value.filter((r) => r.title.toLowerCase().includes(query)).slice(0, 25);
          await c.interaction.respond(results.map((r) => ({ name: r.title.slice(0, 100), value: r.title.slice(0, 100) })));
          return;
        }

        // No broadcaster token yet (or a Helix error) — fall back to titles already configured in the DB for
        // this channel, per the channel-points spec's autocomplete requirement.
        const configured = await c.ctx.prisma.twitchChatReward.findMany({
          where: { channelId: channel.id },
          distinct: ['rewardTitle'],
          orderBy: { createdAt: 'desc' },
          take: 25,
        });
        const results = configured.filter((r) => r.rewardTitle.toLowerCase().includes(query)).slice(0, 25);
        await c.interaction.respond(
          results.map((r) => ({ name: r.rewardTitle.slice(0, 100), value: r.rewardTitle.slice(0, 100) })),
        );
      } catch (err) {
        c.ctx.logger.error({ err }, 'integrations/twitch: reward-title autocomplete failed');
        await c.interaction.respond([]).catch(() => undefined);
      }
      return;
    }

    await c.interaction.respond([]);
  },
};

/** Confirmation-flow button handlers for `/twitch off`, `/twitch command remove`, `/twitch timer remove`,
 * `/twitch reward remove`, and `/twitch reward overlay-reset` (destructive-action convention, ARCHITECTURE.md §7.7). */
export const twitchConfirmComponents: ComponentHandler[] = [
  ...registerConfirmHandlers<Record<string, never>>('twitch-off', async (c) => {
    await disableAllTwitchChatChannels(c.ctx, c.guildId, c.interaction.user.id);
    await c.interaction.followUp({ embeds: [successEmbed(c.t('twitch.off.done'))], ephemeral: true });
  }),
  ...registerConfirmHandlers<{ commandId: string; name: string }>('twitch-command-remove', async (c, payload) => {
    await deleteTwitchChatCommand(c.ctx, c.guildId, c.interaction.user.id, payload.commandId, payload.name);
    await c.interaction.followUp({
      embeds: [successEmbed(c.t('twitch.command.removed', { name: payload.name }))],
      ephemeral: true,
    });
  }),
  ...registerConfirmHandlers<{ timerId: string; name: string }>('twitch-timer-remove', async (c, payload) => {
    await deleteTwitchChatTimer(c.ctx, c.guildId, c.interaction.user.id, payload.timerId, payload.name);
    await c.interaction.followUp({
      embeds: [successEmbed(c.t('twitch.timer.removed', { name: payload.name }))],
      ephemeral: true,
    });
  }),
  ...registerConfirmHandlers<{ rewardId: string; rewardTitle: string }>(
    'twitch-reward-remove',
    async (c, payload) => {
      await deleteTwitchChatReward(c.ctx, c.guildId, c.interaction.user.id, payload.rewardId, payload.rewardTitle);
      await c.interaction.followUp({
        embeds: [successEmbed(c.t('twitch.reward.removed', { title: payload.rewardTitle }))],
        ephemeral: true,
      });
    },
  ),
  ...registerConfirmHandlers<{ channelId: string }>('twitch-overlay-reset', async (c, payload) => {
    const channel = await c.ctx.prisma.twitchChatChannel.findUnique({ where: { id: payload.channelId } });
    if (!channel) {
      await c.interaction.followUp({
        embeds: [errorEmbed(c.t('twitch.errors.channelNotFound', { channel: 'unknown' }))],
        ephemeral: true,
      });
      return;
    }

    // Delete the old token's Redis index if it exists
    if (channel.overlayTokenEnc) {
      try {
        const oldToken = decryptSecret(channel.overlayTokenEnc);
        await c.ctx.redis.del(redisKey('overlay', 'token', oldToken));
      } catch {
        // Ignore decryption failures — orphaned index entries don't affect security
      }
    }

    // Generate a new token
    const token = randomBytes(24).toString('hex');
    await c.ctx.prisma.twitchChatChannel.update({
      where: { id: payload.channelId },
      data: { overlayTokenEnc: encryptSecret(token) },
    });
    await c.ctx.redis.set(redisKey('overlay', 'token', token), payload.channelId);

    await c.ctx.audit({
      guildId: c.guildId,
      actorId: c.interaction.user.id,
      actorType: 'user',
      action: 'integration.twitch_chat.overlay.regenerate',
      targetType: 'twitch_chat_channel',
      targetId: payload.channelId,
      after: { configured: true },
      source: 'bot',
    });

    await c.interaction.followUp({
      embeds: [successEmbed(c.t('twitch.reward.overlayResetDone', { channel: channel.broadcasterLogin }))],
      ephemeral: true,
    });
  }),
];
