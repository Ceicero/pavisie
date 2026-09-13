import type { ButtonInteraction } from 'discord.js';
import { errorEmbed, successEmbed, type ComponentHandler } from '../../sdk';
import { checkRoleAssignable, parseOnboardingProgress, resolveGroupSelection } from '../engine';

/** Buttons-style panel: `roles:toggle:<panelId>:<optionId>` — grants the role if the member doesn't have it, revokes it if they do. Any member may click; not owner-restricted. */
export const panelToggleHandler: ComponentHandler = {
  action: 'toggle',
  kind: 'button',
  ownerOnly: false,
  async handler(c) {
    const [panelId, optionId] = c.args;
    const interaction = c.interaction as ButtonInteraction<'cached'>;

    const panel = await c.ctx.prisma.rolePanel.findFirst({
      where: { id: panelId, guildId: c.guildId, deletedAt: null },
      include: { options: true },
    });
    const option = panel?.options.find((o) => o.id === optionId);
    if (!panel || !option) {
      await interaction.reply({
        embeds: [errorEmbed('This panel option no longer exists.')],
        ephemeral: true,
      });
      return;
    }

    const config = await c.config<import('../manifest').RolesConfig>();
    const guild = interaction.guild;
    await guild.roles.fetch();
    const role = guild.roles.cache.get(option.roleId);
    const botTopRolePosition = guild.members.me?.roles.highest.position ?? 0;

    if (!role) {
      await interaction.reply({
        embeds: [errorEmbed('That role no longer exists in this server.')],
        ephemeral: true,
      });
      return;
    }
    const assignable = checkRoleAssignable({
      permissionsBitfield: role.permissions.bitfield,
      position: role.position,
      managed: role.managed,
      botTopRolePosition,
      allowElevatedRoles: config.allowElevatedRoles,
    });
    if (!assignable.ok) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            "I can't assign that role right now — please tell staff (it may have become elevated, managed, or above my top role).",
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    const member = interaction.member;
    const hasRole = member.roles.cache.has(option.roleId);

    if (hasRole) {
      await member.roles.remove(option.roleId, `Role panel: ${panel.title}`);
      await interaction.reply({ embeds: [successEmbed(`Removed <@&${option.roleId}>.`)], ephemeral: true });
      return;
    }

    if (panel.groupId) {
      const group = await c.ctx.prisma.roleGroup.findUnique({ where: { id: panel.groupId } });
      // An option whose role isn't in the group falls through to the plain add below — the group's exclusivity
      // has nothing to say about it, and resolveGroupSelection would silently drop it from the selection.
      if (group?.roleIds.includes(option.roleId)) {
        const currentGroupRoles = group.roleIds.filter((id) => member.roles.cache.has(id));
        // The clicked role goes FIRST: resolveGroupSelection truncates the requested selection to the group's
        // cap keeping the *earliest* entries, so trailing it means an exclusive group (cap 1) throws away the
        // very role the member just asked for and the click becomes a no-op.
        const { toAdd, toRemove } = resolveGroupSelection(
          group,
          [option.roleId, ...currentGroupRoles],
          currentGroupRoles,
        );
        if (toRemove.length > 0) await member.roles.remove(toRemove, `Role panel group: ${group.name}`);
        if (toAdd.length > 0) await member.roles.add(toAdd, `Role panel: ${panel.title}`);

        // Report what actually changed rather than asserting the click worked.
        const lines: string[] = [];
        if (toAdd.length > 0) lines.push(`Added: ${toAdd.map((id) => `<@&${id}>`).join(', ')}`);
        if (toRemove.length > 0) lines.push(`Removed: ${toRemove.map((id) => `<@&${id}>`).join(', ')}`);
        if (lines.length === 0) lines.push('No changes.');

        await interaction.reply({ embeds: [successEmbed(lines.join('\n'))], ephemeral: true });
        if (toAdd.length > 0) await markRolesPicked(c);
        return;
      }
    }

    await member.roles.add(option.roleId, `Role panel: ${panel.title}`);
    await interaction.reply({ embeds: [successEmbed(`Added <@&${option.roleId}>.`)], ephemeral: true });
    await markRolesPicked(c);
  },
};

/** Records `rolesPickedAt` on `OnboardingProgress` the first time a member self-assigns a role from a panel. */
export async function markRolesPicked(c: {
  ctx: { prisma: import('@pavisie/database').PrismaClient };
  guildId: string;
  interaction: { user: { id: string } };
}): Promise<void> {
  const existing = await c.ctx.prisma.onboardingProgress.findUnique({
    where: { guildId_userId: { guildId: c.guildId, userId: c.interaction.user.id } },
  });
  const progress = parseOnboardingProgress(existing?.steps);
  if (progress.rolesPickedAt) return;
  progress.rolesPickedAt = new Date().toISOString();
  await c.ctx.prisma.onboardingProgress.upsert({
    where: { guildId_userId: { guildId: c.guildId, userId: c.interaction.user.id } },
    create: { guildId: c.guildId, userId: c.interaction.user.id, steps: progress as never },
    update: { steps: progress as never },
  });
}
