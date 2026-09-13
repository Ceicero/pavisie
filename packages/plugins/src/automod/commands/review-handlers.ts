import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { AuditAction } from '@pavisie/core';
import {
  buildCustomId,
  errorEmbed,
  infoEmbed,
  successEmbed,
  type ComponentContext,
  type ComponentHandler,
  type CommandContext,
} from '../../sdk';
import { resolveReview } from '../service';
import { eventSummaryLine, ruleStatusLine } from './format';

const MAX_QUEUE_OPTIONS = 25;

/** `/automod review` — lists pending events as a select menu; picking one shows its detail + Confirm/False-positive buttons (TASK: "review (pending false-positive queue with buttons)"). */
export async function handleReview(c: CommandContext): Promise<void> {
  const events = await c.ctx.prisma.automodEvent.findMany({
    where: { guildId: c.guildId, reviewStatus: { in: ['NONE', 'PENDING'] } },
    orderBy: { createdAt: 'desc' },
    take: MAX_QUEUE_OPTIONS,
  });

  if (events.length === 0) {
    await c.interaction.reply({
      embeds: [infoEmbed(c.t('automod.review.title'), c.t('automod.review.empty'))],
      ephemeral: true,
    });
    return;
  }

  const ruleIds = [...new Set(events.map((e) => e.ruleId))];
  const rules = await c.ctx.prisma.automodRule.findMany({ where: { id: { in: ruleIds } } });
  const ruleNameById = new Map(rules.map((r) => [r.id, r.name]));

  const select = new StringSelectMenuBuilder()
    .setCustomId(buildCustomId('automod', 'review-select', c.interaction.user.id))
    .setPlaceholder('Pick an event to review')
    .addOptions(
      events.map((e) => ({
        label: `${ruleNameById.get(e.ruleId) ?? e.ruleType} — ${e.userId}`.slice(0, 100),
        description: e.matched ? e.matched.slice(0, 90) : undefined,
        value: e.id,
      })),
    );

  await c.interaction.reply({
    embeds: [
      infoEmbed(
        c.t('automod.review.title'),
        events.map((e) => eventSummaryLine(e, ruleNameById.get(e.ruleId) ?? e.ruleType)).join('\n'),
      ),
    ],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    ephemeral: true,
  });
}

async function eventDetailEmbed(c: ComponentContext, eventId: string) {
  const event = await c.ctx.prisma.automodEvent.findFirst({ where: { id: eventId, guildId: c.guildId } });
  if (!event) return null;
  const rule = await c.ctx.prisma.automodRule.findUnique({ where: { id: event.ruleId } });

  const lines = [
    `User: <@${event.userId}>`,
    `Rule: ${rule ? `${rule.name} (${ruleStatusLine(rule, c.ctx.intentsEnabled)})` : event.ruleType}`,
    `Channel: ${event.channelId ? `<#${event.channelId}>` : '—'}`,
    `Actions: ${Array.isArray(event.actionsTaken) ? JSON.stringify(event.actionsTaken) : String(event.actionsTaken)}`,
    `Dry run: ${event.dryRun ? 'Yes' : 'No'}`,
    `Review status: ${event.reviewStatus}`,
  ];
  if (event.matched) lines.push(`Matched content: \`\`\`${event.matched.slice(0, 900)}\`\`\``);

  return { event, embed: infoEmbed(`Automod event #${event.id.slice(0, 8)}`, lines.join('\n')) };
}

function reviewButtonsRow(eventId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('automod', 'review-confirm', eventId))
        .setLabel('Confirm violation')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(buildCustomId('automod', 'review-false-positive', eventId))
        .setLabel('False positive')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export const reviewSelectHandler: ComponentHandler = {
  action: 'review-select',
  kind: 'select',
  ownerOnly: true,
  requirement: { staffLevel: 'helper' },
  async handler(c) {
    const interaction = c.interaction as unknown as StringSelectMenuInteraction<'cached'>;
    const eventId = interaction.values[0];
    if (!eventId) return;

    const payload = await eventDetailEmbed(c, eventId);
    if (!payload) {
      await interaction.update({ embeds: [errorEmbed(c.t('automod.errors.eventNotFound'))], components: [] });
      return;
    }

    const resolved =
      payload.event.reviewStatus === 'CONFIRMED' || payload.event.reviewStatus === 'FALSE_POSITIVE';
    await interaction.update({
      embeds: [payload.embed],
      components: resolved ? [] : reviewButtonsRow(payload.event.id),
    });
  },
};

function makeReviewResolveHandler(status: 'CONFIRMED' | 'FALSE_POSITIVE', label: string): ComponentHandler {
  return {
    action: status === 'CONFIRMED' ? 'review-confirm' : 'review-false-positive',
    kind: 'button',
    ownerOnly: false,
    requirement: { staffLevel: 'helper' },
    async handler(c) {
      const [eventId] = c.args;
      if (!eventId) return;

      const updated = await resolveReview(c.ctx, c.guildId, eventId, status, c.interaction.user.id);
      if (!updated) {
        await c.interaction.reply({
          embeds: [errorEmbed(c.t('automod.errors.eventNotFound'))],
          ephemeral: true,
        });
        return;
      }

      await c.ctx.audit({
        guildId: c.guildId,
        actorId: c.interaction.user.id,
        actorType: 'user',
        action: AuditAction.AutomodEventReview,
        targetType: 'automod_event',
        targetId: eventId,
        after: { reviewStatus: updated.reviewStatus },
        source: 'bot',
      });

      const interaction = c.interaction as unknown as ButtonInteraction<'cached'>;
      const confirmationEmbed = successEmbed(`Marked as **${label}** by <@${c.interaction.user.id}>.`);
      await interaction.update({
        embeds: [...interaction.message.embeds, confirmationEmbed],
        components: [],
      });
    },
  };
}

export const reviewConfirmHandler = makeReviewResolveHandler('CONFIRMED', 'Confirmed violation');
export const reviewFalsePositiveHandler = makeReviewResolveHandler('FALSE_POSITIVE', 'False positive');
