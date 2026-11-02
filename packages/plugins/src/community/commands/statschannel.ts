import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  time,
  TimestampStyles,
  type CategoryChannel,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import {
  channelMention,
  errorEmbed,
  listEmbed,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import type { CommunityConfig } from '../manifest';
import { guildTimezone, refreshGuildStats, statsLastKey } from '../jobs/stats-refresh';
import {
  checkTemplateTokens,
  collectCounts,
  nextRefreshAllowedAt,
  renderStatsName,
  STATS_TOKENS,
} from '../stats-channels';

const MAX_STATS_CHANNELS = 10;
const REFRESH_COOLDOWN_MS = 60_000;

const data = new SlashCommandBuilder()
  .setName('statschannel')
  .setDescription('Server-stats counter channels (member/bot/boost counts in the channel list).')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Create a locked voice channel (or category) that shows a live server count.')
      .addStringOption((opt) =>
        opt
          .setName('template')
          .setDescription(
            'Template, e.g. "Members: {members}" ({members} {humans} {bots} {boosts} {roles} {channels} {date})',
          )
          .setRequired(true)
          .setMaxLength(90),
      )
      .addChannelOption((opt) =>
        opt
          .setName('category')
          .setDescription('Category to create the voice channel under')
          .setRequired(false)
          .addChannelTypes(ChannelType.GuildCategory),
      )
      .addStringOption((opt) =>
        opt
          .setName('kind')
          .setDescription('What to create (default: voice)')
          .setRequired(false)
          .addChoices({ name: 'voice', value: 'voice' }, { name: 'category', value: 'category' }),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Attach an existing channel as a stats counter.')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to rename with the template')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildText),
      )
      .addStringOption((opt) =>
        opt
          .setName('template')
          .setDescription(
            'Name template — tokens: {members} {humans} {bots} {boosts} {roles} {channels} {date}',
          )
          .setRequired(true)
          .setMaxLength(90),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Stop updating a stats channel (the channel itself is not deleted).')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('The stats channel to detach').setRequired(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List the configured stats channels.'))
  .addSubcommand((sub) =>
    sub.setName('refresh').setDescription('Refresh every stats channel now (at most once per 5 minutes).'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('interval')
      .setDescription('Set how often stats channels refresh automatically.')
      .addIntegerOption((opt) =>
        opt
          .setName('minutes')
          .setDescription('Minutes between automatic refreshes (10-1440)')
          .setRequired(true)
          .setMinValue(10)
          .setMaxValue(1440),
      ),
  );

/** Validates a template's tokens; replies with the specific error and returns `false` when it is unusable. */
async function validateTemplate(c: CommandContext, template: string): Promise<boolean> {
  const check = checkTemplateTokens(template);
  if (check.ok) return true;
  const message = check.wantsOnline
    ? c.t('statschannel.onlineNotSupported')
    : c.t('statschannel.badToken', {
        tokens: check.unknown.map((tk) => `{${tk}}`).join(', '),
        known: STATS_TOKENS.map((tk) => `{${tk}}`).join(' '),
      });
  await c.interaction.reply({ embeds: [errorEmbed(message)], ephemeral: true });
  return false;
}

async function currentCounts(c: CommandContext, guild: Guild) {
  const tz = await guildTimezone(c.ctx, c.guildId);
  return collectCounts(guild, tz, { guildMembersIntent: c.ctx.intentsEnabled.guildMembers });
}

function humansNote(c: CommandContext): string {
  return c.ctx.intentsEnabled.guildMembers ? '' : `\n${c.t('statschannel.humansNote')}`;
}

async function handleCreate(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const template = interaction.options.getString('template', true);
  const category = interaction.options.getChannel('category') as CategoryChannel | null;
  const kind = interaction.options.getString('kind') ?? 'voice';

  if (!(await validateTemplate(c, template))) return;

  const cfg = await c.config<CommunityConfig>();
  if (cfg.statsChannels.length >= MAX_STATS_CHANNELS) {
    await interaction.reply({
      embeds: [errorEmbed(t('statschannel.limit', { max: MAX_STATS_CHANNELS }))],
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  const counts = await currentCounts(c, guild);
  const name = renderStatsName(template, counts);

  let created: GuildBasedChannel;
  try {
    if (kind === 'category') {
      created = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        reason: 'Server stats counter',
      });
    } else {
      created = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: category?.id ?? null,
        reason: 'Server stats counter',
        // Visible to everyone, joinable by no one — the channel is just a label in the channel list.
        permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] }],
      });
    }
  } catch (err) {
    ctx.logger.warn(
      { guildId, err: err instanceof Error ? err.message : String(err) },
      'community: /statschannel create failed to create the channel',
    );
    await interaction.reply({ embeds: [errorEmbed(t('statschannel.createFailed'))], ephemeral: true });
    return;
  }

  await ctx.setConfig<CommunityConfig>(
    guildId,
    { statsChannels: [...cfg.statsChannels, { channelId: created.id, template }] },
    { id: interaction.user.id, source: 'bot' },
  );

  await interaction.reply({
    embeds: [
      successEmbed(t('statschannel.created', { channel: channelMention(created.id) }) + humansNote(c)),
    ],
    ephemeral: true,
  });
}

async function handleAdd(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const channel = interaction.options.getChannel('channel', true);
  const template = interaction.options.getString('template', true);

  if (!(await validateTemplate(c, template))) return;

  const cfg = await c.config<CommunityConfig>();
  if (cfg.statsChannels.some((entry) => entry.channelId === channel.id)) {
    await interaction.reply({
      embeds: [errorEmbed(t('statschannel.alreadyAdded', { channel: channelMention(channel.id) }))],
      ephemeral: true,
    });
    return;
  }
  if (cfg.statsChannels.length >= MAX_STATS_CHANNELS) {
    await interaction.reply({
      embeds: [errorEmbed(t('statschannel.limit', { max: MAX_STATS_CHANNELS }))],
      ephemeral: true,
    });
    return;
  }

  await ctx.setConfig<CommunityConfig>(
    guildId,
    { statsChannels: [...cfg.statsChannels, { channelId: channel.id, template }] },
    { id: interaction.user.id, source: 'bot' },
  );

  const counts = await currentCounts(c, interaction.guild);
  await interaction.reply({
    embeds: [
      successEmbed(
        t('statschannel.added', {
          channel: channelMention(channel.id),
          name: renderStatsName(template, counts),
        }) + humansNote(c),
      ),
    ],
    ephemeral: true,
  });
}

async function handleRemove(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const channel = interaction.options.getChannel('channel', true);
  const cfg = await c.config<CommunityConfig>();
  if (!cfg.statsChannels.some((entry) => entry.channelId === channel.id)) {
    await interaction.reply({
      embeds: [errorEmbed(t('statschannel.notTracked', { channel: channelMention(channel.id) }))],
      ephemeral: true,
    });
    return;
  }
  await ctx.setConfig<CommunityConfig>(
    guildId,
    { statsChannels: cfg.statsChannels.filter((entry) => entry.channelId !== channel.id) },
    { id: interaction.user.id, source: 'bot' },
  );
  await interaction.reply({
    embeds: [successEmbed(t('statschannel.removed', { channel: channelMention(channel.id) }))],
    ephemeral: true,
  });
}

async function handleList(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const cfg = await c.config<CommunityConfig>();
  if (cfg.statsChannels.length === 0) {
    await interaction.reply({ embeds: [listEmbed(t('statschannel.listTitle'), [])], ephemeral: true });
    return;
  }
  const counts = await currentCounts(c, interaction.guild);
  const lastIso = await ctx.redis.get(statsLastKey(guildId));
  const last = lastIso ? new Date(lastIso) : null;
  const lines = cfg.statsChannels.map(
    (entry) =>
      `${channelMention(entry.channelId)} — \`${entry.template}\` → **${renderStatsName(entry.template, counts)}**`,
  );
  lines.push(
    t('statschannel.lastRefresh', {
      when:
        last && !Number.isNaN(last.getTime())
          ? time(last, TimestampStyles.RelativeTime)
          : t('statschannel.never'),
      minutes: cfg.statsRefreshMinutes,
    }),
  );
  await interaction.reply({ embeds: [listEmbed(t('statschannel.listTitle'), lines)], ephemeral: true });
}

async function handleRefresh(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const cfg = await c.config<CommunityConfig>();
  if (cfg.statsChannels.length === 0) {
    await interaction.reply({ embeds: [listEmbed(t('statschannel.listTitle'), [])], ephemeral: true });
    return;
  }

  const now = new Date();
  const lastIso = await ctx.redis.get(statsLastKey(guildId));
  const last = lastIso ? new Date(lastIso) : null;
  const allowedAt = nextRefreshAllowedAt(last && !Number.isNaN(last.getTime()) ? last : null, now);
  if (allowedAt.getTime() > now.getTime()) {
    await interaction.reply({
      embeds: [
        errorEmbed(t('statschannel.tooSoon', { when: time(allowedAt, TimestampStyles.RelativeTime) })),
      ],
      ephemeral: true,
    });
    return;
  }

  const limit = await ctx.rateLimiter.consume(
    `community:statschannel-refresh:${guildId}`,
    1,
    REFRESH_COOLDOWN_MS,
  );
  if (!limit.allowed) {
    const retryAt = new Date(now.getTime() + limit.resetMs);
    await interaction.reply({
      embeds: [errorEmbed(t('statschannel.tooSoon', { when: time(retryAt, TimestampStyles.RelativeTime) }))],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  // renameStatsChannel applies the per-channel Redis budget and does not wait on Discord 429 retries.
  const result = await refreshGuildStats(ctx, interaction.guild, cfg, now);
  const summary = t('statschannel.refreshed', {
    renamed: result.renamed,
    unchanged: result.unchanged,
    dropped: result.dropped,
  });
  const embed = result.missingPermission
    ? errorEmbed(`${summary}\n${t('statschannel.missingPermission')}`)
    : successEmbed(summary + humansNote(c));
  await interaction.editReply({ embeds: [embed] });
}

async function handleInterval(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const minutes = interaction.options.getInteger('minutes', true);
  await ctx.setConfig<CommunityConfig>(
    guildId,
    { statsRefreshMinutes: minutes },
    { id: interaction.user.id, source: 'bot' },
  );
  await interaction.reply({
    embeds: [successEmbed(t('statschannel.intervalSet', { minutes }))],
    ephemeral: true,
  });
}

export const command: PluginCommand = {
  data,
  requirement: {
    guildOnly: true,
    staffLevel: 'admin',
    botPermissions: [PermissionFlagsBits.ManageChannels],
  },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    if (sub === 'create') return handleCreate(c);
    if (sub === 'add') return handleAdd(c);
    if (sub === 'remove') return handleRemove(c);
    if (sub === 'list') return handleList(c);
    if (sub === 'refresh') return handleRefresh(c);
    return handleInterval(c);
  },
};
