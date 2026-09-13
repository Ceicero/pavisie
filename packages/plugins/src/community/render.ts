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
import { tallyPoll, type PollOptionTally } from './service';

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

export function buildPollEmbed(poll: Poll, tallies: PollOptionTally[]) {
  const total = tallies.reduce((sum, t) => sum + t.votes, 0);
  const max = Math.max(1, ...tallies.map((t) => t.votes));

  const lines = tallies.map((t, i) => {
    const pct = total > 0 ? Math.round((t.votes / total) * 100) : 0;
    const voters =
      t.voterIds && t.voterIds.length > 0
        ? `\n> ${t.voterIds
            .slice(0, 10)
            .map((id) => `<@${id}>`)
            .join(', ')}${t.voterIds.length > 10 ? ` +${t.voterIds.length - 10} more` : ''}`
        : '';
    return `**${i + 1}. ${t.label}** — ${t.votes} vote${t.votes === 1 ? '' : 's'} (${pct}%)\n${renderBar(t.votes, max)}${voters}`;
  });

  const status = poll.closed ? 'Closed' : poll.endsAt ? `Ends ${discordTimestamp(poll.endsAt, 'R')}` : 'Open';
  const flags = [
    poll.anonymous ? 'anonymous' : 'public votes',
    poll.multiSelect ? 'multiple choice' : 'single choice',
  ].join(' · ');

  return brandEmbed()
    .setTitle(poll.question)
    .setDescription(lines.join('\n\n') || '_No options._')
    .addFields([
      { name: 'Status', value: status, inline: true },
      { name: 'Total votes', value: String(total), inline: true },
      { name: 'Settings', value: flags, inline: true },
    ])
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

export function buildGiveawayEmbed(giveaway: Giveaway, entryCount: number) {
  const fields: EmbedField[] = [
    { name: 'Winners', value: String(giveaway.winnerCount), inline: true },
    { name: 'Entries', value: String(entryCount), inline: true },
    {
      name: giveaway.ended ? 'Ended' : 'Ends',
      value: discordTimestamp(giveaway.endsAt, giveaway.ended ? 'f' : 'R'),
      inline: true,
    },
  ];
  if (giveaway.requiredRoleIds.length > 0)
    fields.push({
      name: 'Required role',
      value: giveaway.requiredRoleIds.map((id) => `<@&${id}>`).join(', '),
      inline: false,
    });
  if (giveaway.minAccountAgeDays)
    fields.push({ name: 'Min. account age', value: `${giveaway.minAccountAgeDays} days`, inline: true });
  if (giveaway.minLevel) fields.push({ name: 'Min. level', value: String(giveaway.minLevel), inline: true });
  if (giveaway.ended) {
    fields.push({
      name: 'Winners',
      value:
        giveaway.winnerIds.length > 0
          ? giveaway.winnerIds.map((id) => `<@${id}>`).join(', ')
          : '_No eligible entries — no winner drawn._',
      inline: false,
    });
  }

  return brandEmbed()
    .setTitle(giveaway.ended ? `🎉 Giveaway ended: ${giveaway.prize}` : `🎉 Giveaway: ${giveaway.prize}`)
    .setDescription(
      giveaway.ended
        ? 'This giveaway has ended.'
        : `Click **Enter** below to join. Hosted by <@${giveaway.hostId}>.`,
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

export function buildEventEmbed(event: CommunityEvent, counts: RsvpCounts, cancelled = false) {
  const fields: EmbedField[] = [
    { name: 'Starts', value: discordTimestamp(event.startsAt, 'F'), inline: true },
  ];
  if (event.endsAt) fields.push({ name: 'Ends', value: discordTimestamp(event.endsAt, 'F'), inline: true });
  fields.push({ name: 'Host', value: `<@${event.hostId}>`, inline: true });
  fields.push({
    name: 'RSVPs',
    value: `✅ Going: ${counts.going} · ❔ Maybe: ${counts.maybe} · ❌ Declined: ${counts.declined}`,
    inline: false,
  });

  return brandEmbed()
    .setTitle(cancelled ? `🚫 Cancelled: ${event.title}` : `📅 ${event.title}`)
    .setDescription(event.description ? truncate(event.description, 3000) : '_No description._')
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
