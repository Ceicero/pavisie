import {
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { AuditAction } from '@pavisie/core';
import { buildCustomId, errorEmbed, successEmbed, type CommandContext, type PluginCommand } from '../../sdk';
import { formatEmbedColorHex } from '../engine';
import type { RolesConfig, WelcomeGoodbyeConfig } from '../manifest';

export type Section = 'welcome' | 'goodbye';

/**
 * Reads one text value back out of the stored embed for the modal's prefill. `embed` is a free-form Json column
 * whose `footer` both writers store as `{ text }`, and `TextInputBuilder.setValue` throws on anything that is
 * not a string — which would blow up before `showModal`, making the embed uneditable from Discord for good.
 * `maxLength` mirrors the input's own `setMaxLength`: the REST API imposes no length cap on `embed`, and Discord
 * rejects `showModal` outright when a prefilled value is longer than its input allows — same dead end.
 */
function embedTextValue(value: unknown, maxLength: number): string {
  if (typeof value === 'string') return value.slice(0, maxLength);
  if (value !== null && typeof value === 'object' && 'text' in value) {
    const text = (value as { text?: unknown }).text;
    return typeof text === 'string' ? text.slice(0, maxLength) : '';
  }
  return '';
}

export function buildSectionCommand(section: Section): PluginCommand['data'] {
  const noun = section === 'welcome' ? 'welcome' : 'goodbye';
  const builder = new SlashCommandBuilder()
    .setName(noun)
    .setDescription(
      section === 'welcome'
        ? 'Configure the message sent when a member joins.'
        : 'Configure the message sent when a member leaves.',
    )
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription(`Set the ${noun} channel/message.`)
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription(`Channel to post ${noun} messages in`)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addStringOption((opt) =>
          opt
            .setName('message')
            .setDescription(
              'Plain-text message. Vars: {user} {user.tag} {user.id} {server} {memberCount} {mention}',
            )
            .setMaxLength(2000),
        )
        .addBooleanOption((opt) =>
          opt.setName('dm').setDescription(`Also DM the member the ${noun} message`),
        ),
    )
    .addSubcommand((sub) => sub.setName('embed').setDescription(`Build the ${noun} embed (opens a form).`))
    .addSubcommand((sub) =>
      sub
        .setName('test')
        .setDescription(`Send a preview of the ${noun} message.`)
        .addChannelOption((opt) =>
          opt.setName('channel').setDescription('Channel to preview in (defaults to the configured one)'),
        ),
    )
    .addSubcommand((sub) => sub.setName('disable').setDescription(`Turn off ${noun} messages.`));
  return builder;
}

async function patchSection(
  c: CommandContext,
  section: Section,
  patch: Partial<WelcomeGoodbyeConfig>,
): Promise<RolesConfig> {
  const current = await c.config<RolesConfig>();
  const nextSection = { ...current[section], ...patch };
  return c.ctx.setConfig<RolesConfig>(c.guildId, { [section]: nextSection } as Partial<RolesConfig>, {
    id: c.interaction.user.id,
    source: 'bot',
  });
}

export function buildSectionExecute(section: Section) {
  return async function execute(c: CommandContext): Promise<void> {
    const interaction = c.interaction as ChatInputCommandInteraction<'cached'>;
    const sub = interaction.options.getSubcommand(true);

    if (sub === 'set') {
      const channel = interaction.options.getChannel('channel');
      const message = interaction.options.getString('message');
      const dm = interaction.options.getBoolean('dm');

      if (channel === null && message === null && dm === null) {
        await interaction.reply({
          embeds: [errorEmbed('Provide at least one of channel, message, or dm.')],
          ephemeral: true,
        });
        return;
      }

      const patch: Partial<WelcomeGoodbyeConfig> = { enabled: true };
      if (channel !== null) patch.channelId = channel.id;
      if (message !== null) patch.message = message;
      if (dm !== null) patch.dm = dm;

      await patchSection(c, section, patch);
      await c.ctx.audit({
        guildId: c.guildId,
        actorId: interaction.user.id,
        actorType: 'user',
        action: AuditAction.RolesWelcomeUpdate,
        targetType: 'plugin_config',
        targetId: 'roles',
        source: 'bot',
      });
      await interaction.reply({
        embeds: [successEmbed(`Updated the ${section} configuration.`)],
        ephemeral: true,
      });
      return;
    }

    if (sub === 'embed') {
      const current = (await c.config<RolesConfig>())[section];
      const existing = (current.embed ?? {}) as Record<string, unknown>;

      const modal = new ModalBuilder()
        .setCustomId(buildCustomId('roles', `${section}-embed-modal`, interaction.user.id))
        .setTitle(`${section === 'welcome' ? 'Welcome' : 'Goodbye'} embed`)
        .addComponents(
          {
            type: 1,
            components: [
              new TextInputBuilder()
                .setCustomId('title')
                .setLabel('Title')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(256)
                .setValue(embedTextValue(existing.title, 256))
                .toJSON(),
            ],
          } as never,
          {
            type: 1,
            components: [
              new TextInputBuilder()
                .setCustomId('description')
                // Discord caps a text input's label at 45 characters and the builder throws above it, so the
                // variable list lives in the placeholder (cap 100) instead.
                .setLabel('Description')
                .setPlaceholder('Vars: {user} {user.tag} {server} {memberCount} {mention}')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setMaxLength(2000)
                .setValue(embedTextValue(existing.description, 2000))
                .toJSON(),
            ],
          } as never,
          {
            type: 1,
            components: [
              new TextInputBuilder()
                .setCustomId('color')
                .setLabel('Color (hex, e.g. #e5e5e5)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(7)
                .setValue(formatEmbedColorHex(existing.color))
                .toJSON(),
            ],
          } as never,
          {
            type: 1,
            components: [
              new TextInputBuilder()
                .setCustomId('footer')
                .setLabel('Footer text')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(256)
                .setValue(embedTextValue(existing.footer, 256))
                .toJSON(),
            ],
          } as never,
        );

      await interaction.showModal(modal);
      return;
    }

    if (sub === 'test') {
      const channel = interaction.options.getChannel('channel');
      await interaction.deferReply({ ephemeral: true });
      const roles = c.ctx.services.get('roles');
      if (!roles) {
        await interaction.editReply({
          embeds: [errorEmbed('The roles service is not available right now.')],
        });
        return;
      }
      try {
        // See service.ts's dual-calling-convention note: in-process calls use the declared positional
        // signature `(guildId, requestedBy, channelId?)`. There's no `section` slot in that signature, so
        // `/goodbye test` is dispatched through the object-call path the way apps/bot/src/host/bot-actions.ts
        // does, since only that path can smuggle the `section`.
        await (
          roles.testWelcome as unknown as (input: {
            guildId: string;
            payload: { channelId?: string; section: Section };
            requestedBy: string;
          }) => Promise<void>
        )({
          guildId: c.guildId,
          payload: { channelId: channel?.id, section },
          requestedBy: interaction.user.id,
        });
        await interaction.editReply({ embeds: [successEmbed('Sent a preview.')] });
      } catch (err) {
        await interaction.editReply({
          embeds: [errorEmbed(err instanceof Error ? err.message : 'Failed to send the preview.')],
        });
      }
      return;
    }

    if (sub === 'disable') {
      await patchSection(c, section, { enabled: false });
      await c.ctx.audit({
        guildId: c.guildId,
        actorId: interaction.user.id,
        actorType: 'user',
        action: AuditAction.RolesWelcomeUpdate,
        targetType: 'plugin_config',
        targetId: 'roles',
        source: 'bot',
      });
      await interaction.reply({
        embeds: [successEmbed(`${section === 'welcome' ? 'Welcome' : 'Goodbye'} messages are now off.`)],
        ephemeral: true,
      });
    }
  };
}
