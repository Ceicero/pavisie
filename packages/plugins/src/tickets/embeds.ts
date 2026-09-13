import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { BRAND, brandIconUrl, discordTimestamp, env, sanitizeEmbedText } from '@pavisie/core';
import type { Ticket, TicketPanel } from '@pavisie/database';
import { buildCustomId } from '../sdk';

/** The panel's posted embed (button-driven ticket creation, ARCHITECTURE.md §7.1 `tickets` row). */
export function buildPanelEmbed(panel: TicketPanel): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle(panel.title)
    .setDescription(sanitizeEmbedText(panel.description, 4000))
    .setFooter({ text: BRAND.name, iconURL: brandIconUrl(env) });
}

/** The button row posted under a panel embed: `tickets:open:<panelId>`. */
export function buildPanelButtons(panelId: string, buttonLabel: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('tickets', 'open', panelId))
      .setLabel(buttonLabel.slice(0, 80))
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎫'),
  );
}

/** The opening embed posted in a newly-created ticket channel/thread. */
export function buildOpeningEmbed(
  ticket: Ticket,
  subject: string | null,
  intake: Record<string, string> | null,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle(`Ticket #${ticket.number}`)
    .setDescription(subject ? sanitizeEmbedText(subject, 4000) : 'No subject given.')
    .addFields(
      { name: 'Opened by', value: `<@${ticket.openerId}>`, inline: true },
      { name: 'Opened', value: discordTimestamp(ticket.createdAt, 'R'), inline: true },
    )
    .setFooter({ text: BRAND.name, iconURL: brandIconUrl(env) })
    .setTimestamp();

  if (ticket.slaDueAt) {
    embed.addFields({ name: 'Response due', value: discordTimestamp(ticket.slaDueAt, 'R'), inline: true });
  }

  if (intake && Object.keys(intake).length > 0) {
    for (const [label, value] of Object.entries(intake)) {
      embed.addFields({ name: label.slice(0, 256), value: sanitizeEmbedText(value || '_No answer._', 1024) });
    }
  }

  return embed;
}

/** Close / Claim / Add-user button row for the opening embed. */
export function buildOpeningButtons(ticketId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('tickets', 'close', ticketId))
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
    new ButtonBuilder()
      .setCustomId(buildCustomId('tickets', 'claim', ticketId))
      .setLabel('Claim')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🙋'),
    new ButtonBuilder()
      .setCustomId(buildCustomId('tickets', 'add-user', ticketId))
      .setLabel('Add user')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('➕'),
  );
}

/** Reopen button posted alongside the closing summary. */
export function buildReopenButton(ticketId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('tickets', 'reopen-btn', ticketId))
      .setLabel('Reopen')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔓'),
  );
}

/** The closing summary embed posted to the transcript channel / DM'd to the opener. */
export function buildClosingSummaryEmbed(ticket: Ticket, reason: string | undefined): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(BRAND.color)
    .setTitle(`Ticket #${ticket.number} closed`)
    .addFields(
      { name: 'Opened by', value: `<@${ticket.openerId}>`, inline: true },
      { name: 'Closed by', value: ticket.closedBy ? `<@${ticket.closedBy}>` : 'Unknown', inline: true },
    )
    .setFooter({ text: BRAND.name, iconURL: brandIconUrl(env) })
    .setTimestamp();

  if (ticket.subject) embed.setDescription(sanitizeEmbedText(ticket.subject, 4000));
  if (reason) embed.addFields({ name: 'Reason', value: sanitizeEmbedText(reason, 1024) });

  return embed;
}
