import { AuditAction } from '@pavisie/core';
import { errorEmbed, PendingStore, successEmbed, type ComponentHandler } from '../../sdk';

interface PendingPanelCreate {
  channelId: string;
  style: 'BUTTONS' | 'SELECT' | 'REACTIONS';
  groupId: string | null;
  maxSelections: number | null;
}

/** Modal submit for `/roles panel create` — the slash command stashes channel/style/group/max-selections in Redis and shows this modal for title/description (SPEC.md §F). */
export const panelCreateModalHandler: ComponentHandler = {
  action: 'panel-create-modal',
  kind: 'modal',
  ownerOnly: true,
  async handler(c) {
    const [, pendingId] = c.args;
    const pendingStore = new PendingStore(c.ctx.redis);
    const pending = pendingId ? await pendingStore.take<PendingPanelCreate>(pendingId) : null;

    if (!pending) {
      await c.interaction.reply({
        embeds: [errorEmbed('That panel-creation session expired. Run `/roles panel create` again.')],
        ephemeral: true,
      });
      return;
    }

    const interaction = c.interaction as unknown as { fields: { getTextInputValue: (id: string) => string } };
    const title = interaction.fields.getTextInputValue('title');
    const description = interaction.fields.getTextInputValue('description') || null;

    const created = await c.ctx.prisma.rolePanel.create({
      data: {
        guildId: c.guildId,
        channelId: pending.channelId,
        title,
        description,
        style: pending.style,
        groupId: pending.groupId,
        maxSelections: pending.maxSelections,
      },
    });

    await c.ctx.audit({
      guildId: c.guildId,
      actorId: c.interaction.user.id,
      actorType: 'user',
      action: AuditAction.RolesPanelCreate,
      targetType: 'role_panel',
      targetId: created.id,
      after: { title: created.title, style: created.style },
      source: 'bot',
    });

    await (c.interaction as unknown as { reply: (opts: unknown) => Promise<unknown> }).reply({
      embeds: [
        successEmbed(
          `Created **${created.title}**. Add options with \`/roles panel option-add\`, then \`/roles panel post\`.`,
        ),
      ],
      ephemeral: true,
    });
  },
};
