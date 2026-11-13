import type { SlashCommandBuilder } from 'discord.js';
import { assertStaffLevel, infoEmbed, paginatedReply, type CommandContext } from '../../sdk';
import { buildRecordSearchWhere } from '../search-filters';

const KIND_CHOICES = ['FLAG', 'DECISION', 'APPEAL_OPENED', 'APPEAL_DECIDED', 'NOTE'].map((k) => ({
  name: k,
  value: k,
}));
const DECISION_CHOICES = ['WARN', 'TIMEOUT', 'MUTE', 'UNMUTE', 'KICK', 'BAN', 'DISMISS'].map((d) => ({
  name: d,
  value: d,
}));

export function addSearchSubcommand(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addSubcommand((sub) =>
    sub
      .setName('search')
      .setDescription('Search the ledger.')
      .addUserOption((opt) => opt.setName('user').setDescription('Filter by user.').setRequired(false))
      .addStringOption((opt) =>
        opt
          .setName('kind')
          .setDescription('Filter by record kind.')
          .addChoices(...KIND_CHOICES)
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName('decision')
          .setDescription('Filter by decision.')
          .addChoices(...DECISION_CHOICES)
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt.setName('policy').setDescription('Filter by policy.').setRequired(false).setAutocomplete(true),
      )
      .addStringOption((opt) =>
        opt.setName('since').setDescription('How far back, e.g. 7d, 24h.').setRequired(false),
      ),
  ) as SlashCommandBuilder;
}

function recordLine(row: {
  recordNumber: number;
  kind: string;
  userId: string;
  decision: string | null;
  status: string | null;
  createdAt: Date;
}): string {
  const parts = [`#E-${row.recordNumber}`, row.kind, `<@${row.userId}>`];
  if (row.decision) parts.push(row.decision);
  else if (row.status) parts.push(row.status);
  parts.push(`<t:${Math.floor(row.createdAt.getTime() / 1000)}:R>`);
  return parts.join(' · ');
}

export async function executeSearch(c: CommandContext): Promise<void> {
  assertStaffLevel(c.staffLevel, 'helper', c.t);

  const user = c.interaction.options.getUser('user');
  const where = buildRecordSearchWhere({
    guildId: c.guildId,
    userId: user?.id,
    kind: c.interaction.options.getString('kind'),
    decision: c.interaction.options.getString('decision'),
    policyId: c.interaction.options.getString('policy'),
    since: c.interaction.options.getString('since'),
  });

  const rows = await c.ctx.prisma.enforcerRecord.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  const PAGE_SIZE = 10;
  const pages = [];
  if (rows.length === 0) {
    pages.push(infoEmbed(c.t('search.title'), c.t('search.empty')));
  } else {
    for (let i = 0; i < rows.length; i += PAGE_SIZE) {
      const slice = rows.slice(i, i + PAGE_SIZE);
      pages.push(
        infoEmbed(c.t('search.titleWithCount', { count: rows.length }), slice.map(recordLine).join('\n')),
      );
    }
  }

  await paginatedReply({
    interaction: c.interaction,
    pages,
    ownerId: c.interaction.user.id,
    pluginId: 'enforcer',
  });
}
