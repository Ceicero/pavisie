import {
  ActionRowBuilder,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  buildCustomId,
  errorEmbed,
  infoEmbed,
  listEmbed,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import { channelPresence, nonBlank } from '../command-input';
import type { CommunityConfig } from '../manifest';
import {
  pruneStickyForChannel,
  removeSticky,
  STICKY_CONTENT_MAX,
  StickyError,
  upsertSticky,
} from '../sticky';
import { stickyPreview } from '../sticky-keys';

export const STICKY_COOLDOWN_MIN = 3;
export const STICKY_COOLDOWN_MAX = 600;

const STICKY_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

const data = new SlashCommandBuilder()
  .setName('sticky')
  .setDescription('Keep a staff message pinned to the bottom of a channel.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Set (or replace) the sticky message for a channel.')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to stick the message in (default: this channel)')
          .setRequired(false)
          .addChannelTypes(...STICKY_CHANNEL_TYPES),
      )
      .addStringOption((opt) =>
        opt
          .setName('content')
          .setDescription('Sticky text. Leave empty to open an editor with embed fields.')
          .setRequired(false)
          .setMaxLength(STICKY_CONTENT_MAX),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('cooldown')
          .setDescription('Minimum seconds between re-posts (default from config, usually 10)')
          .setRequired(false)
          .setMinValue(STICKY_COOLDOWN_MIN)
          .setMaxValue(STICKY_COOLDOWN_MAX),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove the sticky message from a channel.')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to remove the sticky from (default: this channel)')
          .setRequired(false)
          .addChannelTypes(...STICKY_CHANNEL_TYPES),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List every sticky message in this server.'));

/** `https://discord.com/channels/<guild>/<channel>/<message>` jump link to the bot's current sticky post. */
export function stickyJumpLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Maps a `StickyError` to its user-facing locale string. */
export function stickyErrorMessage(c: Pick<CommandContext, 't'>, err: StickyError): string {
  return c.t(`sticky.${err.code}`, err.vars);
}

/** Resolves the target channel id: the explicit option, else the invoking channel when it's a text/announcement channel. */
function resolveTargetChannelId(c: CommandContext): string | null {
  const explicit = c.interaction.options.getChannel('channel');
  if (explicit) return explicit.id;
  const current = c.interaction.channel;
  if (!current) return null;
  return (STICKY_CHANNEL_TYPES as readonly ChannelType[]).includes(current.type) ? current.id : null;
}

/** Builds the `/sticky set` editor modal (content textarea + embed title/description). */
export function buildStickyModal(ownerId: string, channelId: string, cooldownSeconds: number): ModalBuilder {
  const row = (input: TextInputBuilder) => new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  return new ModalBuilder()
    .setCustomId(buildCustomId('community', 'sticky-modal', ownerId, channelId, cooldownSeconds))
    .setTitle('Sticky message')
    .addComponents(
      row(
        new TextInputBuilder()
          .setCustomId('content')
          .setLabel('Message text')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(STICKY_CONTENT_MAX),
      ),
      row(
        new TextInputBuilder()
          .setCustomId('embed_title')
          .setLabel('Embed title (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(256),
      ),
      row(
        new TextInputBuilder()
          .setCustomId('embed_description')
          .setLabel('Embed description (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(4000),
      ),
    );
}

async function handleSet(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const channelId = resolveTargetChannelId(c);
  if (!channelId) {
    await interaction.reply({ embeds: [errorEmbed(t('sticky.badChannel'))], ephemeral: true });
    return;
  }
  if ((await channelPresence(interaction.guild, channelId)) === 'gone') {
    await interaction.reply({ embeds: [errorEmbed(t('sticky.channelGone'))], ephemeral: true });
    return;
  }

  const config = await c.config<CommunityConfig>();
  if (!config.sticky.enabled) {
    await interaction.reply({ embeds: [errorEmbed(t('sticky.disabled'))], ephemeral: true });
    return;
  }

  const rawContent = interaction.options.getString('content');
  const cooldownOption = interaction.options.getInteger('cooldown');
  if (
    cooldownOption !== null &&
    (cooldownOption < STICKY_COOLDOWN_MIN || cooldownOption > STICKY_COOLDOWN_MAX)
  ) {
    await interaction.reply({
      embeds: [errorEmbed(t('sticky.badCooldown', { min: STICKY_COOLDOWN_MIN, max: STICKY_COOLDOWN_MAX }))],
      ephemeral: true,
    });
    return;
  }
  const cooldownSeconds = cooldownOption ?? config.sticky.defaultCooldownSeconds;

  // No content option opens the editor (embed title/description live there). Whitespace is not content.
  if (rawContent === null) {
    await interaction.showModal(buildStickyModal(interaction.user.id, channelId, cooldownSeconds));
    return;
  }
  const content = nonBlank(rawContent);
  if (!content) {
    await interaction.reply({ embeds: [errorEmbed(t('sticky.empty'))], ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const sticky = await upsertSticky(ctx, {
      guild: interaction.guild,
      guildId,
      channelId,
      content,
      cooldownSeconds,
      actorId: interaction.user.id,
    });
    const link = sticky.lastMessageId ? stickyJumpLink(guildId, channelId, sticky.lastMessageId) : null;
    await interaction.editReply({
      embeds: [
        successEmbed(
          `${t('sticky.set', { channel: `<#${channelId}>`, cooldown: cooldownSeconds })}${link ? `\n${link}` : ''}`,
        ),
      ],
    });
  } catch (err) {
    if (err instanceof StickyError) {
      await interaction.editReply({ embeds: [errorEmbed(stickyErrorMessage(c, err))] });
      return;
    }
    throw err;
  }
}

async function handleRemove(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const channelId = resolveTargetChannelId(c);
  if (!channelId) {
    await interaction.reply({ embeds: [errorEmbed(t('sticky.badChannel'))], ephemeral: true });
    return;
  }
  const gone = (await channelPresence(interaction.guild, channelId)) === 'gone';
  await interaction.deferReply({ ephemeral: true });
  // A deleted channel still has a row to clear. removeSticky skips the message delete when the channel is gone,
  // and an already-deleted sticky message (10008) does not fail the removal.
  const removed = await removeSticky(ctx, guildId, channelId, interaction.user.id);
  const text = !removed
    ? t('sticky.notFound', { channel: `<#${channelId}>` })
    : gone
      ? t('sticky.removedDeletedChannel')
      : t('sticky.removed', { channel: `<#${channelId}>` });
  await interaction.editReply({
    embeds: [removed ? successEmbed(text) : errorEmbed(text)],
  });
}

async function handleList(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const rows = await ctx.prisma.stickyMessage.findMany({ where: { guildId }, orderBy: { createdAt: 'asc' } });
  if (rows.length === 0) {
    await interaction.reply({
      embeds: [infoEmbed(t('sticky.listTitle'), t('sticky.listEmpty'))],
      ephemeral: true,
    });
    return;
  }
  const live: typeof rows = [];
  const gone: string[] = [];
  for (const row of rows) {
    if ((await channelPresence(interaction.guild, row.channelId)) === 'gone') gone.push(row.channelId);
    else live.push(row);
  }
  for (const channelId of gone) {
    await pruneStickyForChannel(ctx, guildId, channelId);
  }
  if (live.length === 0) {
    const body =
      gone.length > 0
        ? `${t('sticky.pruned', { count: gone.length })}\n${t('sticky.listEmpty')}`
        : t('sticky.listEmpty');
    await interaction.reply({ embeds: [infoEmbed(t('sticky.listTitle'), body)], ephemeral: true });
    return;
  }
  const lines = live.map((s) => {
    const posted = s.lastPostedAt ? `<t:${Math.floor(s.lastPostedAt.getTime() / 1000)}:R>` : '—';
    const link = s.lastMessageId ? ` · [jump](${stickyJumpLink(guildId, s.channelId, s.lastMessageId)})` : '';
    return `<#${s.channelId}> — ${stickyPreview(s)} — last posted ${posted}${link}`;
  });
  if (gone.length > 0) lines.push(t('sticky.pruned', { count: gone.length }));
  await interaction.reply({ embeds: [listEmbed(t('sticky.listTitle'), lines)], ephemeral: true });
}

export const command: PluginCommand = {
  data,
  requirement: {
    staffLevel: 'moderator',
    guildOnly: true,
    botPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
  },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    if (sub === 'set') return handleSet(c);
    if (sub === 'remove') return handleRemove(c);
    return handleList(c);
  },
};
