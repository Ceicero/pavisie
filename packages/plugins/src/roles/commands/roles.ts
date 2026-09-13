import {
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { formatDuration } from '@pavisie/core';
import {
  assertStaffLevel,
  buildCustomId,
  errorEmbed,
  listEmbed,
  PendingStore,
  successEmbed,
  type CommandContext,
  type PluginCommand,
} from '../../sdk';
import { checkRoleAssignable } from '../engine';
import {
  AUTO_ROLES_MAX_BOT,
  AUTO_ROLES_MAX_DELAY_SECONDS,
  AUTO_ROLES_MAX_HUMAN,
  type RolesConfig,
} from '../manifest';

const PANEL_STYLES = [
  { name: 'Buttons', value: 'BUTTONS' },
  { name: 'Select menu', value: 'SELECT' },
  { name: 'Reactions', value: 'REACTIONS' },
] as const;

const AUTOROLE_AUDIENCES = [
  { name: 'Humans', value: 'humans' },
  { name: 'Bots', value: 'bots' },
] as const;

const data = new SlashCommandBuilder()
  .setName('roles')
  .setDescription('Self-assignable role panels, groups, role persistence, and auto-roles.')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addSubcommandGroup((group) =>
    group
      .setName('panel')
      .setDescription('Role panels — buttons, select menu, or reactions.')
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create a new role panel (opens a form for the title/description).')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('Channel to post it in')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setRequired(true),
          )
          .addStringOption((opt) =>
            opt
              .setName('style')
              .setDescription('How members pick roles')
              .setRequired(true)
              .addChoices(...PANEL_STYLES),
          )
          .addStringOption((opt) =>
            opt
              .setName('group')
              .setDescription('Optional role group id (exclusive/max-selection rules)')
              .setAutocomplete(true),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('max-selections')
              .setDescription('Max roles a member may pick from this panel')
              .setMinValue(1)
              .setMaxValue(25),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('edit')
          .setDescription('Edit a role panel.')
          .addStringOption((opt) =>
            opt.setName('panel').setDescription('Panel to edit').setRequired(true).setAutocomplete(true),
          )
          .addStringOption((opt) => opt.setName('title').setDescription('New title'))
          .addStringOption((opt) => opt.setName('description').setDescription('New description'))
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('New channel')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          )
          .addStringOption((opt) =>
            opt
              .setName('style')
              .setDescription('New style')
              .addChoices(...PANEL_STYLES),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('max-selections')
              .setDescription('New max selections (0 clears it)')
              .setMinValue(0)
              .setMaxValue(25),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a role panel.')
          .addStringOption((opt) =>
            opt.setName('panel').setDescription('Panel to delete').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription("List this server's role panels."))
      .addSubcommand((sub) =>
        sub
          .setName('post')
          .setDescription('Post (or repost) a panel to its channel.')
          .addStringOption((opt) =>
            opt.setName('panel').setDescription('Panel to post').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('option-add')
          .setDescription('Add a role option to a panel.')
          .addStringOption((opt) =>
            opt.setName('panel').setDescription('Panel').setRequired(true).setAutocomplete(true),
          )
          .addRoleOption((opt) => opt.setName('role').setDescription('Role to grant').setRequired(true))
          .addStringOption((opt) =>
            opt
              .setName('label')
              .setDescription('Button/select label (defaults to the role name)')
              .setMaxLength(80),
          )
          .addStringOption((opt) =>
            opt
              .setName('emoji')
              .setDescription('Emoji (required for reaction-style panels)')
              .setMaxLength(64),
          )
          .addStringOption((opt) =>
            opt.setName('description').setDescription('Short description').setMaxLength(200),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('option-remove')
          .setDescription('Remove a role option from a panel.')
          .addStringOption((opt) =>
            opt.setName('panel').setDescription('Panel').setRequired(true).setAutocomplete(true),
          )
          .addRoleOption((opt) => opt.setName('role').setDescription('Role to remove').setRequired(true)),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('group')
      .setDescription('Role groups (exclusive picks / max-selection limits shared across panels).')
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Create a role group.')
          .addStringOption((opt) =>
            opt.setName('name').setDescription('Group name').setRequired(true).setMaxLength(100),
          )
          .addBooleanOption((opt) =>
            opt.setName('exclusive').setDescription('Selecting one role removes the others (default: off)'),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('max-selections')
              .setDescription('Max roles from this group a member may hold')
              .setMinValue(1)
              .setMaxValue(25),
          )
          .addRoleOption((opt) => opt.setName('role1').setDescription('Role to include'))
          .addRoleOption((opt) => opt.setName('role2').setDescription('Role to include'))
          .addRoleOption((opt) => opt.setName('role3').setDescription('Role to include'))
          .addRoleOption((opt) => opt.setName('role4').setDescription('Role to include'))
          .addRoleOption((opt) => opt.setName('role5').setDescription('Role to include')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('edit')
          .setDescription('Edit a role group.')
          .addStringOption((opt) =>
            opt.setName('group').setDescription('Group to edit').setRequired(true).setAutocomplete(true),
          )
          .addStringOption((opt) => opt.setName('name').setDescription('New name'))
          .addBooleanOption((opt) =>
            opt.setName('exclusive').setDescription('Selecting one role removes the others'),
          )
          .addIntegerOption((opt) =>
            opt
              .setName('max-selections')
              .setDescription('Max roles from this group (0 clears it)')
              .setMinValue(0)
              .setMaxValue(25),
          )
          .addRoleOption((opt) => opt.setName('add-role').setDescription('Role to add to the group'))
          .addRoleOption((opt) => opt.setName('remove-role').setDescription('Role to remove from the group')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('delete')
          .setDescription('Delete a role group.')
          .addStringOption((opt) =>
            opt.setName('group').setDescription('Group to delete').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription("List this server's role groups.")),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('persist')
      .setDescription('Role persistence for returning members.')
      .addSubcommand((sub) =>
        sub.setName('on').setDescription('Turn on role persistence (disclosed to admins).'),
      )
      .addSubcommand((sub) => sub.setName('off').setDescription('Turn off role persistence.'))
      .addSubcommand((sub) => sub.setName('status').setDescription('Show whether role persistence is on.')),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('autorole')
      .setDescription('Auto-roles given to every new member (humans and bots separately).')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a role to the auto-role list (max 5 for humans, 3 for bots).')
          .addRoleOption((opt) => opt.setName('role').setDescription('Role to give').setRequired(true))
          .addStringOption((opt) =>
            opt
              .setName('for')
              .setDescription('Who gets it (default: humans)')
              .addChoices(...AUTOROLE_AUDIENCES),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a role from the auto-role lists.')
          .addRoleOption((opt) => opt.setName('role').setDescription('Role to remove').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('Show the current auto-role setup.'))
      .addSubcommand((sub) =>
        sub
          .setName('delay')
          .setDescription('Delay before auto-roles land (0 = immediately, max 7 days).')
          .addIntegerOption((opt) =>
            opt
              .setName('seconds')
              .setDescription('Seconds to wait after the member finishes joining')
              .setMinValue(0)
              .setMaxValue(AUTO_ROLES_MAX_DELAY_SECONDS)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('enable')
          .setDescription('Turn auto-roles on or off.')
          .addBooleanOption((opt) =>
            opt.setName('on').setDescription('true = on, false = off').setRequired(true),
          ),
      ),
  );

const ROLE_PERSISTENCE_DISCLOSURE =
  "When on, Pavisie stores a snapshot of a leaving member's roles (excluding elevated-permission and integration-managed roles) for up to the configured number of days, and restores them automatically if that member rejoins within that window. This is stored per-member in the database until it expires or is restored.";

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'moderator', guildOnly: true },
  async execute(c) {
    const group = c.interaction.options.getSubcommandGroup(true);
    const sub = c.interaction.options.getSubcommand(true);
    const config = await c.config<RolesConfig>();

    if (group === 'panel') return handlePanel(c.interaction, c, sub, config);
    if (group === 'group') return handleGroup(c.interaction, c, sub);
    if (group === 'persist') return handlePersist(c.interaction, c, sub);
    if (group === 'autorole') return handleAutorole(c.interaction, c, sub, config);
  },
  async autocomplete(c) {
    const focused = c.interaction.options.getFocused(true);
    const query = String(focused.value).toLowerCase();

    if (focused.name === 'panel') {
      const panels = await c.ctx.prisma.rolePanel.findMany({
        where: { guildId: c.guildId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const matches = panels.filter((p) => p.title.toLowerCase().includes(query)).slice(0, 25);
      await c.interaction.respond(
        matches.map((p) => ({ name: `${p.title} (${p.style.toLowerCase()})`, value: p.id })),
      );
      return;
    }

    if (focused.name === 'group') {
      const groups = await c.ctx.prisma.roleGroup.findMany({
        where: { guildId: c.guildId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const matches = groups.filter((g) => g.name.toLowerCase().includes(query)).slice(0, 25);
      await c.interaction.respond(matches.map((g) => ({ name: g.name, value: g.id })));
      return;
    }

    await c.interaction.respond([]);
  },
};

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

async function handlePanel(
  interaction: ChatInputCommandInteraction<'cached'>,
  c: CommandContext,
  sub: string,
  config: RolesConfig,
): Promise<void> {
  if (sub === 'create') {
    const channel = interaction.options.getChannel('channel', true);
    const style = interaction.options.getString('style', true);
    const groupId = interaction.options.getString('group');
    const maxSelections = interaction.options.getInteger('max-selections');

    if (groupId) {
      const group = await c.ctx.prisma.roleGroup.findFirst({ where: { id: groupId, guildId: c.guildId } });
      if (!group) {
        await interaction.reply({ embeds: [errorEmbed('That role group was not found.')], ephemeral: true });
        return;
      }
    }

    const pendingStore = new PendingStore(c.ctx.redis);
    const pendingId = await pendingStore.put(
      { channelId: channel.id, style, groupId: groupId ?? null, maxSelections: maxSelections ?? null },
      300,
    );

    const modal = new ModalBuilder()
      .setCustomId(buildCustomId('roles', 'panel-create-modal', interaction.user.id, pendingId))
      .setTitle('New role panel')
      .addComponents(
        // discord.js requires each text input wrapped in its own ActionRow; the SDK's confirm/pagination helpers
        // don't cover modals, so this is built directly against discord.js's builder API.
        {
          type: 1,
          components: [
            new TextInputBuilder()
              .setCustomId('title')
              .setLabel('Title')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(100)
              .setRequired(true)
              .toJSON(),
          ],
        } as never,
        {
          type: 1,
          components: [
            new TextInputBuilder()
              .setCustomId('description')
              .setLabel('Description (optional)')
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(2000)
              .setRequired(false)
              .toJSON(),
          ],
        } as never,
      );

    await interaction.showModal(modal);
    return;
  }

  if (sub === 'edit') {
    const panelId = interaction.options.getString('panel', true);
    const existing = await c.ctx.prisma.rolePanel.findFirst({
      where: { id: panelId, guildId: c.guildId, deletedAt: null },
    });
    if (!existing) {
      await interaction.reply({ embeds: [errorEmbed('Role panel not found.')], ephemeral: true });
      return;
    }

    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');
    const channel = interaction.options.getChannel('channel');
    const style = interaction.options.getString('style');
    const maxSelectionsRaw = interaction.options.getInteger('max-selections');

    await c.ctx.prisma.rolePanel.update({
      where: { id: panelId },
      data: {
        ...(title !== null ? { title } : {}),
        ...(description !== null ? { description } : {}),
        ...(channel !== null ? { channelId: channel.id } : {}),
        ...(style !== null ? { style: style as never } : {}),
        ...(maxSelectionsRaw !== null
          ? { maxSelections: maxSelectionsRaw === 0 ? null : maxSelectionsRaw }
          : {}),
      },
    });

    await c.ctx.audit({
      guildId: c.guildId,
      actorId: interaction.user.id,
      actorType: 'user',
      action: 'roles.panel.update',
      targetType: 'role_panel',
      targetId: panelId,
      source: 'bot',
    });
    await interaction.reply({
      embeds: [successEmbed('Panel updated. Run `/roles panel post` to push the change to Discord.')],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'delete') {
    const panelId = interaction.options.getString('panel', true);
    const existing = await c.ctx.prisma.rolePanel.findFirst({
      where: { id: panelId, guildId: c.guildId, deletedAt: null },
    });
    if (!existing) {
      await interaction.reply({ embeds: [errorEmbed('Role panel not found.')], ephemeral: true });
      return;
    }
    await c.ctx.prisma.rolePanel.update({ where: { id: panelId }, data: { deletedAt: new Date() } });
    await c.ctx.audit({
      guildId: c.guildId,
      actorId: interaction.user.id,
      actorType: 'user',
      action: 'roles.panel.delete',
      targetType: 'role_panel',
      targetId: panelId,
      source: 'bot',
    });
    await interaction.reply({
      embeds: [successEmbed(`Deleted **${existing.title}**. The posted message (if any) was left as-is.`)],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'list') {
    const panels = await c.ctx.prisma.rolePanel.findMany({
      where: { guildId: c.guildId, deletedAt: null },
      include: { options: true },
      orderBy: { createdAt: 'desc' },
    });
    const lines = panels.map(
      (p: {
        title: string;
        style: string;
        channelId: string;
        options: unknown[];
        messageId: string | null;
      }) =>
        `**${p.title}** — ${p.style.toLowerCase()} · <#${p.channelId}> · ${p.options.length} option(s)${p.messageId ? '' : ' · _not posted yet_'}`,
    );
    await interaction.reply({ embeds: [listEmbed('Role panels', lines)], ephemeral: true });
    return;
  }

  if (sub === 'post') {
    const panelId = interaction.options.getString('panel', true);
    await interaction.deferReply({ ephemeral: true });
    const roles = c.ctx.services.get('roles');
    if (!roles) {
      await interaction.editReply({ embeds: [errorEmbed('The roles service is not available right now.')] });
      return;
    }
    try {
      await roles.postPanel(c.guildId, panelId, interaction.user.id);
      await interaction.editReply({ embeds: [successEmbed('Panel posted.')] });
    } catch (err) {
      await interaction.editReply({
        embeds: [errorEmbed(err instanceof Error ? err.message : 'Failed to post the panel.')],
      });
    }
    return;
  }

  if (sub === 'option-add') {
    const panelId = interaction.options.getString('panel', true);
    const role = interaction.options.getRole('role', true);
    const label = interaction.options.getString('label') ?? role.name;
    const emoji = interaction.options.getString('emoji');
    const description = interaction.options.getString('description');

    const panel = await c.ctx.prisma.rolePanel.findFirst({
      where: { id: panelId, guildId: c.guildId, deletedAt: null },
      include: { options: true },
    });
    if (!panel) {
      await interaction.reply({ embeds: [errorEmbed('Role panel not found.')], ephemeral: true });
      return;
    }
    if (panel.style === 'REACTIONS' && !emoji) {
      await interaction.reply({
        embeds: [errorEmbed('Reaction-style panels need an emoji for every option.')],
        ephemeral: true,
      });
      return;
    }
    if (panel.options.length >= 25) {
      await interaction.reply({
        embeds: [errorEmbed('A panel can have at most 25 options.')],
        ephemeral: true,
      });
      return;
    }

    const botTopRolePosition = interaction.guild.members.me?.roles.highest.position ?? 0;
    const guildRole =
      interaction.guild.roles.cache.get(role.id) ??
      (await interaction.guild.roles.fetch(role.id).catch(() => null));
    const permissionsBitfield =
      typeof role.permissions === 'string' ? BigInt(role.permissions) : role.permissions.bitfield;
    const result = checkRoleAssignable({
      permissionsBitfield,
      position: guildRole?.position ?? 0,
      managed: guildRole?.managed ?? false,
      botTopRolePosition,
      allowElevatedRoles: config.allowElevatedRoles,
    });
    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(assignabilityReasonMessage(result.reason))],
        ephemeral: true,
      });
      return;
    }

    await c.ctx.prisma.rolePanelOption.create({
      data: { panelId, roleId: role.id, label, emoji, description, position: panel.options.length },
    });
    await interaction.reply({
      embeds: [
        successEmbed(
          `Added **${label}** → <@&${role.id}>. Run \`/roles panel post\` to update the posted message.`,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'option-remove') {
    const panelId = interaction.options.getString('panel', true);
    const role = interaction.options.getRole('role', true);
    const deleted = await c.ctx.prisma.rolePanelOption.deleteMany({ where: { panelId, roleId: role.id } });
    if (deleted.count === 0) {
      await interaction.reply({
        embeds: [errorEmbed('That role is not an option on this panel.')],
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      embeds: [successEmbed('Removed. Run `/roles panel post` to update the posted message.')],
      ephemeral: true,
    });
    return;
  }
}

function assignabilityReasonMessage(reason: 'elevated' | 'managed' | 'hierarchy'): string {
  if (reason === 'elevated')
    return "That role grants an elevated permission (Administrator, Manage Server/Roles/Channels/Webhooks, Kick/Ban/Timeout Members, or Mention Everyone). Enable `allowElevatedRoles` in this plugin's config to allow it anyway.";
  if (reason === 'managed')
    return 'That role is managed by an integration or bot and cannot be self-assigned.';
  return "That role is at or above my own highest role, so I can't grant or remove it. Move my role above it in Server Settings → Roles.";
}

// ---------------------------------------------------------------------------
// group
// ---------------------------------------------------------------------------

async function handleGroup(
  interaction: ChatInputCommandInteraction<'cached'>,
  c: CommandContext,
  sub: string,
): Promise<void> {
  if (sub === 'create') {
    const name = interaction.options.getString('name', true);
    const exclusive = interaction.options.getBoolean('exclusive') ?? false;
    const maxSelections = interaction.options.getInteger('max-selections');
    const roleIds = ['role1', 'role2', 'role3', 'role4', 'role5']
      .map((key) => interaction.options.getRole(key))
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => r.id);

    const created = await c.ctx.prisma.roleGroup.create({
      data: { guildId: c.guildId, name, exclusive, maxSelections, roleIds },
    });
    await interaction.reply({
      embeds: [successEmbed(`Created role group **${created.name}** with ${roleIds.length} role(s).`)],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'edit') {
    const groupId = interaction.options.getString('group', true);
    const existing = await c.ctx.prisma.roleGroup.findFirst({ where: { id: groupId, guildId: c.guildId } });
    if (!existing) {
      await interaction.reply({ embeds: [errorEmbed('Role group not found.')], ephemeral: true });
      return;
    }
    const name = interaction.options.getString('name');
    const exclusive = interaction.options.getBoolean('exclusive');
    const maxSelectionsRaw = interaction.options.getInteger('max-selections');
    const addRole = interaction.options.getRole('add-role');
    const removeRole = interaction.options.getRole('remove-role');

    let roleIds = existing.roleIds;
    if (addRole && !roleIds.includes(addRole.id)) roleIds = [...roleIds, addRole.id];
    if (removeRole) roleIds = roleIds.filter((id: string) => id !== removeRole.id);

    await c.ctx.prisma.roleGroup.update({
      where: { id: groupId },
      data: {
        ...(name !== null ? { name } : {}),
        ...(exclusive !== null ? { exclusive } : {}),
        ...(maxSelectionsRaw !== null
          ? { maxSelections: maxSelectionsRaw === 0 ? null : maxSelectionsRaw }
          : {}),
        roleIds,
      },
    });
    await interaction.reply({ embeds: [successEmbed('Role group updated.')], ephemeral: true });
    return;
  }

  if (sub === 'delete') {
    const groupId = interaction.options.getString('group', true);
    const existing = await c.ctx.prisma.roleGroup.findFirst({ where: { id: groupId, guildId: c.guildId } });
    if (!existing) {
      await interaction.reply({ embeds: [errorEmbed('Role group not found.')], ephemeral: true });
      return;
    }
    await c.ctx.prisma.rolePanel.updateMany({
      where: { guildId: c.guildId, groupId },
      data: { groupId: null },
    });
    await c.ctx.prisma.roleGroup.delete({ where: { id: groupId } });
    await interaction.reply({
      embeds: [successEmbed(`Deleted role group **${existing.name}**.`)],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'list') {
    const groups = await c.ctx.prisma.roleGroup.findMany({
      where: { guildId: c.guildId },
      orderBy: { createdAt: 'desc' },
    });
    const lines = groups.map(
      (g: { name: string; exclusive: boolean; maxSelections: number | null; roleIds: string[] }) =>
        `**${g.name}** — ${g.exclusive ? 'exclusive (max 1)' : g.maxSelections ? `max ${g.maxSelections}` : 'no limit'} · ${g.roleIds.length} role(s)`,
    );
    await interaction.reply({ embeds: [listEmbed('Role groups', lines)], ephemeral: true });
    return;
  }
}

// ---------------------------------------------------------------------------
// persist
// ---------------------------------------------------------------------------

async function handlePersist(
  interaction: ChatInputCommandInteraction<'cached'>,
  c: CommandContext,
  sub: string,
): Promise<void> {
  assertStaffLevel(c.staffLevel, 'admin', c.t);

  if (sub === 'status') {
    const config = await c.config<RolesConfig>();
    await interaction.reply({
      embeds: [
        listEmbed('Role persistence', [
          `Status: ${config.rolePersistence.enabled ? 'On' : 'Off'}`,
          `Restore window: ${config.rolePersistence.maxDays} day(s)`,
          ROLE_PERSISTENCE_DISCLOSURE,
        ]),
      ],
      ephemeral: true,
    });
    return;
  }

  const enabled = sub === 'on';
  const after = await c.ctx.setConfig<RolesConfig>(
    c.guildId,
    { rolePersistence: { ...(await c.config<RolesConfig>()).rolePersistence, enabled } },
    { id: interaction.user.id, source: 'bot' },
  );
  await c.ctx.audit({
    guildId: c.guildId,
    actorId: interaction.user.id,
    actorType: 'user',
    action: 'roles.persistence.toggle',
    targetType: 'plugin_config',
    targetId: 'roles',
    after: { enabled },
    source: 'bot',
  });

  await interaction.reply({
    embeds: [
      successEmbed(
        `Role persistence is now **${enabled ? 'on' : 'off'}**.${enabled ? `\n\n${ROLE_PERSISTENCE_DISCLOSURE}` : ''} (Restore window: ${after.rolePersistence.maxDays} day(s).)`,
      ),
    ],
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// autorole
// ---------------------------------------------------------------------------

type AutoroleAudience = 'humans' | 'bots';

function autoroleListKey(audience: AutoroleAudience): 'roleIds' | 'botRoleIds' {
  return audience === 'bots' ? 'botRoleIds' : 'roleIds';
}

function autoroleLimit(audience: AutoroleAudience): number {
  return audience === 'bots' ? AUTO_ROLES_MAX_BOT : AUTO_ROLES_MAX_HUMAN;
}

function formatDelay(c: CommandContext, seconds: number): string {
  return seconds <= 0 ? c.t('autorole.delayImmediate') : formatDuration(seconds * 1000);
}

function formatRoleList(c: CommandContext, roleIds: string[]): string {
  return roleIds.length > 0 ? roleIds.map((id) => `<@&${id}>`).join(', ') : c.t('autorole.listNone');
}

async function handleAutorole(
  interaction: ChatInputCommandInteraction<'cached'>,
  c: CommandContext,
  sub: string,
  config: RolesConfig,
): Promise<void> {
  const autoRoles = config.autoRoles;

  if (sub === 'list') {
    const lines = [
      c.t('autorole.listStatus', { status: autoRoles.enabled ? 'On' : 'Off' }),
      c.t('autorole.listHumans', { roles: formatRoleList(c, autoRoles.roleIds) }),
      c.t('autorole.listBots', { roles: formatRoleList(c, autoRoles.botRoleIds) }),
      c.t('autorole.listDelay', { delay: formatDelay(c, autoRoles.delaySeconds) }),
      c.t('autorole.safetyNote'),
    ];
    await interaction.reply({ embeds: [listEmbed(c.t('autorole.listTitle'), lines)], ephemeral: true });
    return;
  }

  // Everything below writes config → admin only (the command-level requirement is moderator so `list` stays read-only for mods).
  assertStaffLevel(c.staffLevel, 'admin', c.t);

  if (sub === 'add') {
    const role = interaction.options.getRole('role', true);
    const audience = (interaction.options.getString('for') ?? 'humans') as AutoroleAudience;
    const key = autoroleListKey(audience);
    const current = autoRoles[key];

    if (current.includes(role.id)) {
      await interaction.reply({
        embeds: [errorEmbed(c.t('autorole.alreadyAdded', { role: `<@&${role.id}>`, audience }))],
        ephemeral: true,
      });
      return;
    }
    if (current.length >= autoroleLimit(audience)) {
      await interaction.reply({
        embeds: [errorEmbed(c.t('autorole.limit', { max: autoroleLimit(audience) }))],
        ephemeral: true,
      });
      return;
    }

    const botTopRolePosition = interaction.guild.members.me?.roles.highest.position ?? 0;
    const guildRole =
      interaction.guild.roles.cache.get(role.id) ??
      (await interaction.guild.roles.fetch(role.id).catch(() => null));
    const permissionsBitfield =
      typeof role.permissions === 'string' ? BigInt(role.permissions) : role.permissions.bitfield;
    const result = checkRoleAssignable({
      permissionsBitfield,
      position: guildRole?.position ?? 0,
      managed: guildRole?.managed ?? false,
      botTopRolePosition,
      allowElevatedRoles: config.allowElevatedRoles,
    });
    if (!result.ok) {
      const refusal =
        result.reason === 'elevated'
          ? c.t('autorole.refused.elevated')
          : result.reason === 'managed'
            ? c.t('autorole.refused.managed')
            : c.t('autorole.refused.hierarchy');
      await interaction.reply({ embeds: [errorEmbed(refusal)], ephemeral: true });
      return;
    }

    await c.ctx.setConfig<RolesConfig>(
      c.guildId,
      { autoRoles: { ...autoRoles, [key]: [...current, role.id] } },
      { id: interaction.user.id, source: 'bot' },
    );
    const hint = autoRoles.enabled ? '' : `\n\n${c.t('autorole.notEnabledHint')}`;
    await interaction.reply({
      embeds: [successEmbed(c.t('autorole.added', { role: `<@&${role.id}>`, audience }) + hint)],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'remove') {
    const role = interaction.options.getRole('role', true);
    const inHumans = autoRoles.roleIds.includes(role.id);
    const inBots = autoRoles.botRoleIds.includes(role.id);
    if (!inHumans && !inBots) {
      await interaction.reply({ embeds: [errorEmbed(c.t('autorole.notConfigured'))], ephemeral: true });
      return;
    }
    await c.ctx.setConfig<RolesConfig>(
      c.guildId,
      {
        autoRoles: {
          ...autoRoles,
          roleIds: autoRoles.roleIds.filter((id) => id !== role.id),
          botRoleIds: autoRoles.botRoleIds.filter((id) => id !== role.id),
        },
      },
      { id: interaction.user.id, source: 'bot' },
    );
    await interaction.reply({
      embeds: [successEmbed(c.t('autorole.removed', { role: `<@&${role.id}>` }))],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'delay') {
    const seconds = interaction.options.getInteger('seconds', true);
    await c.ctx.setConfig<RolesConfig>(
      c.guildId,
      { autoRoles: { ...autoRoles, delaySeconds: seconds } },
      { id: interaction.user.id, source: 'bot' },
    );
    await interaction.reply({
      embeds: [successEmbed(c.t('autorole.delaySet', { delay: formatDelay(c, seconds) }))],
      ephemeral: true,
    });
    return;
  }

  if (sub === 'enable') {
    const on = interaction.options.getBoolean('on', true);
    await c.ctx.setConfig<RolesConfig>(
      c.guildId,
      { autoRoles: { ...autoRoles, enabled: on } },
      { id: interaction.user.id, source: 'bot' },
    );
    await interaction.reply({
      embeds: [successEmbed(c.t(on ? 'autorole.enabled' : 'autorole.disabled'))],
      ephemeral: true,
    });
    return;
  }
}
