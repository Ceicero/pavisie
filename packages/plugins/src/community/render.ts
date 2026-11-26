// discord.js embed/component builders for the community plugin. Kept separate from service.ts (which stays
// discord.js-free) so the pure tally/eligibility/vote logic can be unit-tested without a gateway.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { BRAND, brandIconUrl, discordTimestamp, env, truncate } from '@pavisie/core';
import type {
  EventRsvp,
  Giveaway,
  Poll,
  PollOption,
  PollVote,
  Suggestion,
  CommunityEvent,
} from '@pavisie/database';
import { brandEmbed, buildCustomId } from '../sdk';
import { pollOutcome, tallyPoll, type PollOptionTally } from './service';

const BAR_WIDTH = 12;

type EmbedField = { name: string; value: string; inline?: boolean };

function renderBar(count: number, max: number): string {
  if (max <= 0) return '░'.repeat(BAR_WIDTH);
  const filled = Math.round((count / max) * BAR_WIDTH);
  return '█'.repeat(Math.min(BAR_WIDTH, filled)) + '░'.repeat(Math.max(0, BAR_WIDTH - filled));
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

export function buildPollEmbed(
  poll: Poll,
  tallies: PollOptionTally[],
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  const total = tallies.reduce((sum, tally) => sum + tally.votes, 0);
  const max = Math.max(1, ...tallies.map((tally) => tally.votes));

  const lines = tallies.map((tally, i) => {
    const pct = total > 0 ? Math.round((tally.votes / total) * 100) : 0;
    const voters =
      tally.voterIds && tally.voterIds.length > 0
        ? `\n> ${tally.voterIds
            .slice(0, 10)
            .map((id) => `<@${id}>`)
            .join(', ')}${tally.voterIds.length > 10 ? ` +${tally.voterIds.length - 10} more` : ''}`
        : '';
    return `**${i + 1}. ${tally.label}** — ${tally.votes} vote${tally.votes === 1 ? '' : 's'} (${pct}%)\n${renderBar(tally.votes, max)}${voters}`;
  });

  const status = poll.closed
    ? t('poll.statusClosed')
    : poll.endsAt
      ? t('poll.statusEnds', { time: discordTimestamp(poll.endsAt, 'R') })
      : t('poll.statusOpen');
  const flags = [
    poll.anonymous ? 'anonymous' : 'public votes',
    poll.multiSelect ? 'multiple choice' : 'single choice',
  ].join(' · ');

  const fields: EmbedField[] = [
    { name: 'Status', value: status, inline: true },
    { name: 'Total votes', value: String(total), inline: true },
    { name: 'Settings', value: flags, inline: true },
  ];
  if (poll.closed) {
    const outcome = pollOutcome(tallies);
    const votesLabel = `${outcome.votes} vote${outcome.votes === 1 ? '' : 's'}`;
    const result =
      outcome.kind === 'winner'
        ? `${outcome.labels[0]} (${votesLabel})`
        : outcome.kind === 'tie'
          ? `Tie: ${outcome.labels.join(', ')} (${votesLabel} each)`
          : 'No votes';
    fields.push({ name: 'Result', value: result, inline: false });
  }

  return brandEmbed()
    .setTitle(poll.question)
    .setDescription(lines.join('\n\n') || '_No options._')
    .addFields(fields)
    .setFooter({ text: `${BRAND.name} · Poll #${poll.id.slice(-6)}`, iconURL: brandIconUrl(env) });
}

export function buildPollComponents(
  pollId: string,
  options: PollOption[],
  closed: boolean,
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  if (closed) return [];
  const sorted = [...options].sort((a, b) => a.position - b.position);

  if (sorted.length <= 5) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      sorted.map((opt, i) => {
        const button = new ButtonBuilder()
          .setCustomId(buildCustomId('community', 'vote', pollId, opt.id))
          .setLabel(truncate(`${i + 1}. ${opt.label}`, 80))
          .setStyle(ButtonStyle.Primary);
        if (opt.emoji) button.setEmoji(opt.emoji);
        return button;
      }),
    );
    return [row];
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(buildCustomId('community', 'vote-select', pollId))
    .setPlaceholder('Choose an option to vote')
    .addOptions(
      sorted.map((opt, i) => ({
        label: truncate(`${i + 1}. ${opt.label}`, 100),
        value: opt.id,
        emoji: opt.emoji ?? undefined,
      })),
    );

  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
}

export function tallyPollFromRows(poll: Poll, options: PollOption[], votes: PollVote[]): PollOptionTally[] {
  return tallyPoll(options, votes, poll.anonymous);
}

// ---------------------------------------------------------------------------
// Giveaways
// ---------------------------------------------------------------------------

export function buildGiveawayEmbed(
  giveaway: Giveaway,
  entryCount: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  const fields: EmbedField[] = [
    { name: t('giveaway.embedWinners'), value: String(giveaway.winnerCount), inline: true },
    { name: t('giveaway.embedEntries'), value: String(entryCount), inline: true },
    {
      name: t(giveaway.ended ? 'giveaway.embedEnded' : 'giveaway.embedEnds'),
      value: discordTimestamp(giveaway.endsAt, giveaway.ended ? 'f' : 'R'),
      inline: true,
    },
  ];
  if (giveaway.requiredRoleIds.length > 0)
    fields.push({
      name: t('giveaway.embedRequiredRole'),
      value: giveaway.requiredRoleIds.map((id) => `<@&${id}>`).join(', '),
      inline: false,
    });
  if (giveaway.minAccountAgeDays) {
    const days = giveaway.minAccountAgeDays;
    fields.push({
      name: t('giveaway.embedMinAccountAge'),
      value: t(days === 1 ? 'giveaway.embedAccountAgeDay' : 'giveaway.embedAccountAgeDays', { days }),
      inline: true,
    });
  }
  if (giveaway.minLevel)
    fields.push({ name: t('giveaway.embedMinLevel'), value: String(giveaway.minLevel), inline: true });
  if (giveaway.ended) {
    fields.push({
      name: t('giveaway.embedDrawnWinners'),
      value:
        giveaway.winnerIds.length > 0
          ? giveaway.winnerIds.map((id) => `<@${id}>`).join(', ')
          : t('giveaway.embedNoWinner'),
      inline: false,
    });
  }

  return brandEmbed()
    .setTitle(
      t(giveaway.ended ? 'giveaway.embedTitleEnded' : 'giveaway.embedTitle', {
        prize: giveaway.prize,
      }),
    )
    .setDescription(
      giveaway.ended
        ? t('giveaway.embedDescriptionEnded')
        : t('giveaway.embedDescription', { host: `<@${giveaway.hostId}>` }),
    )
    .addFields(fields);
}

export function buildGiveawayComponents(
  giveawayId: string,
  ended: boolean,
): ActionRowBuilder<ButtonBuilder>[] {
  if (ended) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('community', 'gw-enter', giveawayId))
        .setLabel('🎉 Enter')
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

const SUGGESTION_STATUS_LABEL: Record<Suggestion['status'], string> = {
  PENDING: '🕗 Pending',
  APPROVED: '✅ Approved',
  DENIED: '❌ Denied',
  IMPLEMENTED: '🚀 Implemented',
  CONSIDERING: '🤔 Considering',
};

export function buildSuggestionEmbed(suggestion: Suggestion) {
  const embed = brandEmbed()
    .setTitle(`Suggestion #${suggestion.number}`)
    .setDescription(truncate(suggestion.content, 3800))
    .addFields([
      { name: 'Author', value: `<@${suggestion.authorId}>`, inline: true },
      { name: 'Status', value: SUGGESTION_STATUS_LABEL[suggestion.status], inline: true },
      { name: 'Votes', value: `👍 ${suggestion.upvotes} · 👎 ${suggestion.downvotes}`, inline: true },
    ]);
  if (suggestion.staffNote) {
    embed.addFields([{ name: 'Staff note', value: truncate(suggestion.staffNote, 1000) }]);
  }
  return embed;
}

export function buildSuggestionComponents(suggestionId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('community', 'sugg-vote', suggestionId, 'up'))
        .setLabel('👍')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buildCustomId('community', 'sugg-vote', suggestionId, 'down'))
        .setLabel('👎')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface RsvpCounts {
  going: number;
  maybe: number;
  declined: number;
}

export function summarizeRsvps(rsvps: EventRsvp[]): RsvpCounts {
  return {
    going: rsvps.filter((r) => r.status === 'GOING').length,
    maybe: rsvps.filter((r) => r.status === 'MAYBE').length,
    declined: rsvps.filter((r) => r.status === 'DECLINED').length,
  };
}

export function buildEventEmbed(
  event: CommunityEvent,
  counts: RsvpCounts,
  t: (key: string, vars?: Record<string, string | number>) => string,
  cancelled = false,
) {
  const fields: EmbedField[] = [
    { name: t('event.embedStarts'), value: discordTimestamp(event.startsAt, 'F'), inline: true },
  ];
  if (event.endsAt) {
    fields.push({ name: t('event.embedEnds'), value: discordTimestamp(event.endsAt, 'F'), inline: true });
  }
  fields.push({ name: t('event.embedHost'), value: `<@${event.hostId}>`, inline: true });
  fields.push({
    name: t('event.embedRsvps'),
    value: t('event.embedRsvpCounts', {
      going: counts.going,
      maybe: counts.maybe,
      declined: counts.declined,
    }),
    inline: false,
  });

  return brandEmbed()
    .setTitle(cancelled ? t('event.embedTitleCancelled', { title: event.title }) : `📅 ${event.title}`)
    .setDescription(event.description ? truncate(event.description, 3000) : t('event.embedNoDescription'))
    .addFields(fields);
}

export function buildEventComponents(eventId: string, cancelled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  if (cancelled) return [];
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('community', 'rsvp', eventId, 'going'))
        .setLabel('✅ Going')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(buildCustomId('community', 'rsvp', eventId, 'maybe'))
        .setLabel('❔ Maybe')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buildCustomId('community', 'rsvp', eventId, 'declined'))
        .setLabel("❌ Can't go")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}
