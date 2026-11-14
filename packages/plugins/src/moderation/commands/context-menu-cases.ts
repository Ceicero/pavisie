import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { assertStaffLevel, errorEmbed, listEmbed, paginatedReply, type PluginCommand } from '../../sdk';
import { caseTypeLabel } from '../embeds';
import { moderationService } from './shared';

const data = new ContextMenuCommandBuilder()
  .setName('View cases')
  .setType(ApplicationCommandType.User)
  .setDMPermission(false)
  // Helper-level command (see `requirement` below), so it must not be gated on ModerateMembers — same reasoning
  // as `/mod` in commands/mod.ts.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

export const command: PluginCommand = {
  data,
  requirement: { staffLevel: 'helper', guildOnly: true },
  async execute(c) {
    await c.interaction.reply({
      embeds: [errorEmbed(c.t('errors.not_found', { thing: 'Command' }))],
      ephemeral: true,
    });
  },
  async executeContextMenu(c) {
    assertStaffLevel(c.staffLevel, 'helper', c.t);
    // `ContextMenuContext.interaction` is typed as the umbrella `ContextMenuCommandInteraction`, which has no
    // `targetUser` — this command is only ever registered as a User context menu (`data.setType(User)` above),
    // so narrowing here is safe (checked at runtime with isUserContextMenuCommand()).
    if (!c.interaction.isUserContextMenuCommand()) {
      throw new Error('moderation: expected a user context menu interaction');
    }
    const target = c.interaction.targetUser;
    const service = moderationService(c.ctx);

    const pages: EmbedBuilder[] = [];
    let cursor: string | null = null;
    do {
      const page = await service.listCases({ guildId: c.guildId, targetId: target.id, cursor, limit: 10 });
      if (page.items.length === 0 && pages.length === 0) break;
      pages.push(
        listEmbed(
          `Cases — ${target.tag}`,
          page.items.map(
            (row) => `#${row.caseNumber} — ${caseTypeLabel(row.type)} — ${row.reason ?? '_No reason_'}`,
          ),
        ),
      );
      cursor = page.nextCursor;
    } while (cursor && pages.length < 10);

    await paginatedReply({
      interaction: c.interaction,
      pages,
      ownerId: c.interaction.user.id,
      pluginId: 'moderation',
    });
  },
};
