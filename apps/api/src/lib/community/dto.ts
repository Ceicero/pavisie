// Maps Prisma rows to the community/economy DTOs in `@pavisie/types/community` (same pattern as
// apps/api/src/lib/dto.ts, kept in this new file per the community build stage's ownership).
import type {
  CommunityEvent,
  EventRsvp,
  Giveaway,
  Poll,
  PollOption,
  PollVote,
  ScheduledAnnouncement,
  StickyMessage,
  Suggestion,
  Tag,
} from '@pavisie/database';
import type {
  AnnouncementContentDto,
  AnnouncementDto,
  CommunityEventDto,
  GiveawayDto,
  PollDto,
  PollOptionDto,
  PollResultsDto,
  StickyMessageDto,
  SuggestionDto,
  TagDto,
  TagEmbedDto,
} from '@pavisie/types/community';
import { isTagEmbedEmpty, tagEmbedSchema } from './tag-schemas';
import { parseStickyEmbed } from '@pavisie/plugins/community/sticky-keys';

export function toPollOptionDto(row: PollOption, votes: PollVote[], anonymous: boolean): PollOptionDto {
  const optionVotes = votes.filter((v) => v.optionId === row.id);
  const dto: PollOptionDto = {
    id: row.id,
    label: row.label,
    position: row.position,
    emoji: row.emoji,
    votes: optionVotes.length,
  };
  if (!anonymous) dto.voterIds = optionVotes.map((v) => v.userId);
  return dto;
}

export function toPollDto(row: Poll & { options: PollOption[]; votes?: PollVote[] }): PollDto {
  const votes = row.votes ?? [];
  const options = [...row.options]
    .sort((a, b) => a.position - b.position)
    .map((o) => toPollOptionDto(o, votes, row.anonymous));
  return {
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    question: row.question,
    anonymous: row.anonymous,
    multiSelect: row.multiSelect,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    closed: row.closed,
    createdBy: row.createdBy,
    totalVotes: votes.length,
    options,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPollResultsDto(row: Poll, options: PollOption[], votes: PollVote[]): PollResultsDto {
  const sorted = [...options]
    .sort((a, b) => a.position - b.position)
    .map((o) => toPollOptionDto(o, votes, row.anonymous));
  return {
    pollId: row.id,
    question: row.question,
    anonymous: row.anonymous,
    closed: row.closed,
    totalVotes: votes.length,
    options: sorted,
  };
}

export function toGiveawayDto(row: Giveaway & { entryCount: number }): GiveawayDto {
  return {
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    messageId: row.messageId,
    prize: row.prize,
    winnerCount: row.winnerCount,
    hostId: row.hostId,
    endsAt: row.endsAt.toISOString(),
    ended: row.ended,
    requiredRoleIds: row.requiredRoleIds,
    minAccountAgeDays: row.minAccountAgeDays,
    minLevel: row.minLevel,
    winnerIds: row.winnerIds,
    entryCount: row.entryCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSuggestionDto(row: Suggestion): SuggestionDto {
  return {
    id: row.id,
    guildId: row.guildId,
    number: row.number,
    authorId: row.authorId,
    channelId: row.channelId,
    messageId: row.messageId,
    content: row.content,
    status: row.status,
    staffNote: row.staffNote,
    threadId: row.threadId,
    upvotes: row.upvotes,
    downvotes: row.downvotes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAnnouncementContent(raw: unknown): AnnouncementContentDto {
  if (
    raw &&
    typeof raw === 'object' &&
    'content' in raw &&
    typeof (raw as { content: unknown }).content === 'string'
  ) {
    return { content: (raw as { content: string }).content };
  }
  return { content: '' };
}

export function toAnnouncementDto(row: ScheduledAnnouncement): AnnouncementDto {
  return {
    id: row.id,
    guildId: row.guildId,
    channelId: row.channelId,
    content: toAnnouncementContent(row.content),
    cron: row.cron,
    runAt: row.runAt ? row.runAt.toISOString() : null,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCommunityEventDto(row: CommunityEvent, rsvps: EventRsvp[]): CommunityEventDto {
  return {
    id: row.id,
    guildId: row.guildId,
    title: row.title,
    description: row.description,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    channelId: row.channelId,
    messageId: row.messageId,
    hostId: row.hostId,
    discordEventId: row.discordEventId,
    reminderMinutes: row.reminderMinutes,
    rsvps: {
      going: rsvps.filter((r) => r.status === 'GOING').length,
      maybe: rsvps.filter((r) => r.status === 'MAYBE').length,
      declined: rsvps.filter((r) => r.status === 'DECLINED').length,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toTagEmbedDto(raw: unknown): TagEmbedDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = tagEmbedSchema.safeParse(raw);
  if (!parsed.success || isTagEmbedEmpty(parsed.data)) return null;
  return parsed.data;
}

export function toTagDto(row: Tag): TagDto {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    embed: toTagEmbedDto(row.embed),
    triggerMode: row.triggerMode,
    trigger: row.trigger,
    triggerChannelIds: row.triggerChannelIds,
    staffOnly: row.staffOnly,
    uses: row.uses,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toStickyDto(row: StickyMessage): StickyMessageDto {
  return {
    id: row.id,
    channelId: row.channelId,
    content: row.content,
    embed: parseStickyEmbed(row.embed),
    cooldownSeconds: row.cooldownSeconds,
    lastMessageId: row.lastMessageId,
    lastPostedAt: row.lastPostedAt ? row.lastPostedAt.toISOString() : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
