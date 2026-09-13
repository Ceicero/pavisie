import { ChannelType, SlashCommandBuilder, type VoiceBasedChannel } from 'discord.js';
import type { TempVoiceChannel } from '@pavisie/database';
import {
  assertStaffLevel,
  errorEmbed,
  fetchMemberSafe,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import type { EngagementConfig } from '../manifest';

const data = new SlashCommandBuilder()
  .setName('tempvoice')
  .setDescription('Temporary voice channels.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Register a hub channel: joining it creates a personal voice channel.')
      .addChannelOption((opt) =>
        opt
          .setName('hub')
          .setDescription('The "Join to create" voice channel.')
          .addChannelTypes(ChannelType.GuildVoice)
          .setRequired(true),
      )
      .addChannelOption((opt) =>
        opt
          .setName('category')
          .setDescription("Category new channels are created under (defaults to the hub's category).")
          .addChannelTypes(ChannelType.GuildCategory),
      )
      .addStringOption((opt) =>
        opt
          .setName('name-template')
          .setDescription("Channel name template. {user} is replaced with the owner's name.")
          .setMaxLength(90),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('lock').setDescription('Lock your temp channel so only permitted members can join.'),
  )
  .addSubcommand((sub) => sub.setName('unlock').setDescription('Unlock your temp channel.'))
  .addSubcommand((sub) =>
    sub
      .setName('limit')
      .setDescription("Set your temp channel's user limit.")
      .addIntegerOption((opt) =>
        opt.setName('count').setDescription('0 = no limit.').setMinValue(0).setMaxValue(99).setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('rename')
      .setDescription('Rename your temp channel.')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('New channel name.')
          .setMinLength(1)
          .setMaxLength(90)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('claim').setDescription('Claim ownership of this temp channel (its owner has left).'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('kick')
      .setDescription('Disconnect a member from your temp channel.')
      .addUserOption((opt) => opt.setName('user').setDescription('Member to kick.').setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('permit')
      .setDescription('Allow a member to join your locked temp channel.')
      .addUserOption((opt) => opt.setName('user').setDescription('Member to permit.').setRequired(true)),
  );

interface OwnedChannel {
  row: TempVoiceChannel;
  channel: VoiceBasedChannel;
}

async function getCurrentTempChannel(c: CommandContext): Promise<OwnedChannel | null> {
  const channelId = c.interaction.member.voice.channelId;
  if (!channelId) return null;
  const row = await c.ctx.prisma.tempVoiceChannel.findUnique({ where: { channelId } });
  if (!row) return null;
  const channel = c.interaction.guild.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased()) return null;
  return { row, channel };
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);

    if (sub === 'setup') {
      assertStaffLevel(c.staffLevel, 'admin', c.t);
      const hub = c.interaction.options.getChannel('hub', true);
      const category = c.interaction.options.getChannel('category');
      const template = c.interaction.options.getString('name-template');

      const config = await c.config<EngagementConfig>();
      const hubIds = new Set(config.tempVoice.hubChannelIds);
      hubIds.add(hub.id);

      await c.ctx.setConfig<EngagementConfig>(
        c.guildId,
        {
          tempVoice: {
            ...config.tempVoice,
            hubChannelIds: [...hubIds],
            categoryId: category?.id ?? config.tempVoice.categoryId,
            nameTemplate: template ?? config.tempVoice.nameTemplate,
          },
        },
        { id: c.interaction.user.id, source: 'bot' },
      );

      await c.interaction.reply({
        embeds: [successEmbed(c.t('tempvoice.setup.success', { channel: `<#${hub.id}>` }))],
        ephemeral: true,
      });
      return;
    }

    const owned = await getCurrentTempChannel(c);
    if (!owned) {
      await c.interaction.reply({
        embeds: [errorEmbed(c.t('errors.tempVoiceNotInChannel'))],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'claim') {
      const currentOwnerStillPresent = owned.channel.members.has(owned.row.ownerId);
      if (currentOwnerStillPresent && owned.row.ownerId !== c.interaction.user.id) {
        await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.tempVoiceNotOwner'))], ephemeral: true });
        return;
      }
      await c.ctx.prisma.tempVoiceChannel.update({
        where: { id: owned.row.id },
        data: { ownerId: c.interaction.user.id },
      });
      await owned.channel.permissionOverwrites
        .edit(c.interaction.user.id, {
          Connect: true,
          ManageChannels: true,
          MoveMembers: true,
          MuteMembers: true,
          DeafenMembers: true,
        })
        .catch(() => undefined);
      await c.interaction.reply({
        embeds: [successEmbed(c.t('tempvoice.claimed', { user: c.interaction.user.toString() }))],
        ephemeral: true,
      });
      return;
    }

    if (owned.row.ownerId !== c.interaction.user.id) {
      await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.tempVoiceNotOwner'))], ephemeral: true });
      return;
    }

    if (sub === 'lock') {
      // The @everyone deny below applies to the owner too — only Administrator bypasses a channel Connect
      // denial. Re-grant it on the owner's own overwrite first, so this also repairs channels created
      // before Connect was part of the creation overwrite.
      await owned.channel.permissionOverwrites
        .edit(owned.row.ownerId, { Connect: true })
        .catch(() => undefined);
      await owned.channel.permissionOverwrites
        .edit(c.interaction.guild.roles.everyone, { Connect: false })
        .catch(() => undefined);
      await c.interaction.reply({ embeds: [successEmbed(c.t('tempvoice.locked'))], ephemeral: true });
      return;
    }

    if (sub === 'unlock') {
      await owned.channel.permissionOverwrites
        .edit(c.interaction.guild.roles.everyone, { Connect: null })
        .catch(() => undefined);
      await c.interaction.reply({ embeds: [successEmbed(c.t('tempvoice.unlocked'))], ephemeral: true });
      return;
    }

    if (sub === 'limit') {
      const count = c.interaction.options.getInteger('count', true);
      await owned.channel.setUserLimit(count).catch(() => undefined);
      await c.interaction.reply({
        embeds: [successEmbed(c.t('tempvoice.limitSet', { limit: count }))],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'rename') {
      const name = c.interaction.options.getString('name', true).slice(0, 100);
      await owned.channel.setName(name).catch(() => undefined);
      await c.interaction.reply({
        embeds: [successEmbed(c.t('tempvoice.renamed', { name }))],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'kick') {
      const target = c.interaction.options.getUser('user', true);
      if (target.id === c.interaction.user.id) {
        await c.interaction.reply({ embeds: [errorEmbed('You cannot kick yourself.')], ephemeral: true });
        return;
      }
      const targetMember = await fetchMemberSafe(c.interaction.guild, target.id);
      if (!targetMember || targetMember.voice.channelId !== owned.channel.id) {
        await c.interaction.reply({ embeds: [errorEmbed(c.t('errors.userNotFound'))], ephemeral: true });
        return;
      }
      await targetMember.voice.disconnect('Kicked by temp voice channel owner').catch(() => undefined);
      await c.interaction.reply({
        embeds: [successEmbed(c.t('tempvoice.kicked', { user: target.toString() }))],
        ephemeral: true,
      });
      return;
    }

    // sub === 'permit'
    const target = c.interaction.options.getUser('user', true);
    await owned.channel.permissionOverwrites.edit(target.id, { Connect: true }).catch(() => undefined);
    await c.interaction.reply({
      embeds: [successEmbed(c.t('tempvoice.permitted', { user: target.toString() }))],
      ephemeral: true,
    });
  },
};
