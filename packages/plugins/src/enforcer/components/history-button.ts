import type { ButtonInteraction } from 'discord.js';
import { infoEmbed, type ComponentHandler } from '../../sdk';

/** `enforcer:history:<recordId>` — "Suspect history": counts + last 5 records for the flagged user. */
const historyHandler: ComponentHandler = {
  action: 'history',
  kind: 'button',
  ownerOnly: false,
  requirement: { staffLevel: 'helper' },
  async handler(c) {
    const [recordId] = c.args;
    const interaction = c.interaction as ButtonInteraction<'cached'>;

    const record = await c.ctx.prisma.enforcerRecord.findFirst({
      where: { id: recordId, guildId: c.guildId },
    });
    if (!record) {
      await interaction.reply({
        embeds: [infoEmbed(c.t('record.notFoundTitle'), c.t('record.notFound'))],
        ephemeral: true,
      });
      return;
    }

    const [flagCount, decisionCount, recent] = await Promise.all([
      c.ctx.prisma.enforcerRecord.count({
        where: { guildId: c.guildId, userId: record.userId, kind: 'FLAG' },
      }),
      c.ctx.prisma.enforcerRecord.count({
        where: { guildId: c.guildId, userId: record.userId, kind: 'DECISION' },
      }),
      c.ctx.prisma.enforcerRecord.findMany({
        where: { guildId: c.guildId, userId: record.userId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    const lines = [
      `Total flags: **${flagCount}** · Total decisions: **${decisionCount}**`,
      '',
      ...recent.map(
        (r) =>
          `#E-${r.recordNumber} · ${r.kind}${r.decision ? ` (${r.decision})` : ''} · <t:${Math.floor(r.createdAt.getTime() / 1000)}:R>`,
      ),
    ];

    await interaction.reply({
      embeds: [infoEmbed(c.t('history.title', { userId: record.userId }), lines.join('\n'))],
      ephemeral: true,
    });
  },
};

export const historyButtonComponents: ComponentHandler[] = [historyHandler];
