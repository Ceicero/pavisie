import { AttachmentBuilder, type SlashCommandBuilder } from 'discord.js';
import { parseDuration } from '@pavisie/core';
import { assertStaffLevel, infoEmbed, type CommandContext } from '../../sdk';
import { recordsToCsv } from '../csv';

export function addExportSubcommand(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addSubcommand((sub) =>
    sub
      .setName('export')
      .setDescription('Export ledger records as CSV.')
      .addStringOption((opt) =>
        opt.setName('since').setDescription('How far back, e.g. 30d.').setRequired(false),
      ),
  ) as SlashCommandBuilder;
}

export async function executeExport(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'admin', c.t);

  const sinceRaw = c.interaction.options.getString('since');
  const since = sinceRaw ? parseDuration(sinceRaw) : null;

  const rows = await c.ctx.prisma.enforcerRecord.findMany({
    where: { guildId: c.guildId, ...(since ? { createdAt: { gte: new Date(Date.now() - since) } } : {}) },
    orderBy: { createdAt: 'asc' },
  });

  if (rows.length === 0) {
    await c.interaction.reply({ embeds: [infoEmbed('Export', c.t('export.empty'))], ephemeral: true });
    return;
  }

  const csv = recordsToCsv(rows);
  const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf-8'), {
    name: `enforcer-records-${c.guildId}.csv`,
  });

  await c.ctx.audit({
    guildId: c.guildId,
    actorId: c.interaction.user.id,
    actorType: 'user',
    action: 'data.export.request',
    targetType: 'enforcer_record',
    after: { count: rows.length },
    source: 'bot',
  });

  await c.interaction.reply({ content: `${rows.length} record(s).`, files: [attachment], ephemeral: true });
}
