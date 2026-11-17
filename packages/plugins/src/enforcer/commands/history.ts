import type { SlashCommandBuilder } from 'discord.js';
import { assertStaffLevel, infoEmbed, type CommandContext } from '../../sdk';

export function addHistorySubcommand(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addSubcommand((sub) =>
    sub
      .setName('history')
      .setDescription("Summarize a user's Enforcer history.")
      .addUserOption((opt) => opt.setName('user').setDescription('User').setRequired(true)),
  ) as SlashCommandBuilder;
}

export async function executeHistory(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'helper', c.t);

  const user = c.interaction.options.getUser('user', true);
  const [flagCount, decisionCount, recent] = await Promise.all([
    c.ctx.prisma.enforcerRecord.count({ where: { guildId: c.guildId, userId: user.id, kind: 'FLAG' } }),
    c.ctx.prisma.enforcerRecord.count({ where: { guildId: c.guildId, userId: user.id, kind: 'DECISION' } }),
    c.ctx.prisma.enforcerRecord.findMany({
      where: { guildId: c.guildId, userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
  ]);

  const lines = [
    c.t('history.totalFlags', { count: flagCount }),
    c.t('history.totalDecisions', { count: decisionCount }),
    '',
    c.t('history.lastRecords'),
    ...recent.map(
      (r) =>
        `#E-${r.recordNumber} · ${r.kind}${r.decision ? ` (${r.decision})` : ''} · <t:${Math.floor(r.createdAt.getTime() / 1000)}:R>`,
    ),
  ];

  await c.interaction.reply({
    embeds: [infoEmbed(c.t('history.title', { userId: user.id }), lines.join('\n'))],
    ephemeral: true,
  });
}
