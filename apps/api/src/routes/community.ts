import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { AppError, AuditAction, NotFoundError, buildPaginated, paginate } from '@pavisie/core';
import { Prisma } from '@pavisie/database';
import { stickyChannelsKey } from '@pavisie/plugins/community/sticky-keys';
import { autoPublishCountKey, utcDayKey } from '@pavisie/plugins/community/channel-automations';
import type { Paginated } from '@pavisie/types';
import type {
  AnnouncementDto,
  BirthdayConfigDto,
  BirthdaySummaryDto,
  ChannelAutomationStatsDto,
  CommunityEventDto,
  EconomySettingsDto,
  GiveawayDto,
  PollDto,
  PollResultsDto,
  StickyMessageDto,
  SuggestionDto,
  TagDto,
} from '@pavisie/types/community';
import {
  toAnnouncementDto,
  toCommunityEventDto,
  toGiveawayDto,
  toPollDto,
  toPollResultsDto,
  toStickyDto,
  toSuggestionDto,
  toTagDto,
} from '../lib/community/dto';
import { cancelAnnouncementJob } from '../lib/community/queue';
import { tagBodySchema, tagTriggersCacheKey, type TagBody } from '../lib/community/tag-schemas';
import { writeDashboardAudit } from '../lib/audit';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema, paginationQuerySchema, snowflakeSchema } from '../lib/schemas';
import type { CommunityConfig } from '@pavisie/plugins/community/manifest';
import { findUnknownMessageTokens, localNow, upcomingSorted } from '@pavisie/plugins/community/birthdays';

const ECONOMY_PLUGIN_ID = 'economy' as const;
const COMMUNITY_PLUGIN_ID = 'community' as const;
/** Mirrors the plugin config default (`tags.maxTags`) as a hard fallback if the config store is unavailable. */
const DEFAULT_MAX_TAGS = 200;

const tagParamSchema = guildIdParamSchema.extend({ tagId: z.string().min(1) });
const tagListQuerySchema = paginationQuerySchema.extend({ q: z.string().trim().max(32).optional() });

/** 409 — a tag with that name already exists in the guild. */
function tagExistsError(name: string): AppError {
  return new AppError('tag_exists', `A tag named "${name}" already exists.`, { status: 409, expose: true });
}

/** True for Prisma's unique-constraint-violation error (P2002) — same check as `webhooks.ts`'s `claimEventOnce`. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Maps the validated body to Prisma column values (`embed` → `Prisma.DbNull` when absent so an edit can clear it). */
function tagDataFromBody(body: TagBody) {
  return {
    name: body.name,
    content: body.content ?? null,
    embed: body.embed ? (body.embed as Prisma.InputJsonValue) : Prisma.DbNull,
    triggerMode: body.triggerMode,
    trigger: body.triggerMode === 'NONE' ? null : (body.trigger ?? null),
    triggerChannelIds: body.triggerMode === 'NONE' ? [] : body.triggerChannelIds,
    staffOnly: body.staffOnly,
  };
}

function tagAuditSnapshot(body: {
  name: string;
  triggerMode: string;
  trigger: string | null | undefined;
  triggerChannelIds: string[];
  staffOnly: boolean;
  content: string | null | undefined;
  embed: unknown;
}) {
  return {
    name: body.name,
    triggerMode: body.triggerMode,
    trigger: body.trigger ?? null,
    triggerChannelIds: body.triggerChannelIds,
    staffOnly: body.staffOnly,
    hasContent: Boolean(body.content),
    hasEmbed: Boolean(body.embed),
  };
}
const BIRTHDAY_NEXT_LIMIT = 10;

const birthdayUserParamSchema = guildIdParamSchema.extend({ userId: snowflakeSchema });
/** Mirrors `configSchema.shape.birthdays` in the community manifest (every field optional for a PUT patch). */
const birthdayConfigBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    channelId: snowflakeSchema.nullable().optional(),
    message: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => findUnknownMessageTokens(value).length === 0, {
        message: 'Unknown message token; supported tokens are {mention}, {user}, {server}.',
      })
      .optional(),
    announceHour: z.number().int().min(0).max(23).optional(),
    roleId: snowflakeSchema.nullable().optional(),
    publicList: z.boolean().optional(),
    allowSelfService: z.boolean().optional(),
  })
  .strict();

const suggestionParamSchema = guildIdParamSchema.extend({ suggestionId: z.string().min(1) });
const suggestionStatusSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'DENIED', 'IMPLEMENTED', 'CONSIDERING']),
  staffNote: z.string().trim().max(1000).optional(),
});

const pollParamSchema = guildIdParamSchema.extend({ pollId: z.string().min(1) });
const announcementParamSchema = guildIdParamSchema.extend({ announcementId: z.string().min(1) });
const stickyParamSchema = guildIdParamSchema.extend({ stickyId: z.string().min(1) });

const economySettingsBodySchema = z
  .object({
    currencyName: z.string().trim().min(1).max(32).optional(),
    currencySymbol: z.string().trim().min(1).max(8).optional(),
    dailyMinAmount: z.number().int().min(0).max(1_000_000).optional(),
    dailyMaxAmount: z.number().int().min(0).max(1_000_000).optional(),
    streakBonusPerDay: z.number().int().min(0).max(10_000).optional(),
    streakBonusMax: z.number().int().min(0).max(1_000_000).optional(),
    giveMinAmount: z.number().int().min(1).max(1_000_000_000).optional(),
    giveMaxAmount: z.number().int().min(1).max(1_000_000_000).optional(),
  })
  .strict();

/** `/guilds/:guildId/community` — giveaways/polls/suggestions/announcements/events/stickies overview + suggestion status workflow, channel-automation stats, plus `/guilds/:guildId/economy/config` (ARCHITECTURE.md §10). */
export default async function communityRoutes(app: ZodFastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Giveaways
  // -------------------------------------------------------------------------

  app.get(
    '/:guildId/community/giveaways',
    {
      schema: { params: guildIdParamSchema, querystring: paginationQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<GiveawayDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.giveaway.findMany({
        where: { guildId },
        orderBy: { endsAt: 'desc' },
        include: { _count: { select: { entries: true } } },
        skip: offset,
        take: limit + 1,
      });
      const dtos = rows.map((row) => toGiveawayDto({ ...row, entryCount: row._count.entries }));
      return buildPaginated(dtos, limit, offset);
    },
  );

  // -------------------------------------------------------------------------
  // Polls
  // -------------------------------------------------------------------------

  app.get(
    '/:guildId/community/polls',
    {
      schema: { params: guildIdParamSchema, querystring: paginationQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<PollDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.poll.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        include: { options: true, votes: true },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toPollDto), limit, offset);
    },
  );

  app.get(
    '/:guildId/community/polls/:pollId/results',
    { schema: { params: pollParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<PollResultsDto> => {
      const guildId = request.guildId!;
      const { pollId } = request.params as { pollId: string };
      const poll = await app.prisma.poll.findFirst({ where: { id: pollId, guildId } });
      if (!poll) throw new NotFoundError('Poll not found.');
      const [options, votes] = await Promise.all([
        app.prisma.pollOption.findMany({ where: { pollId } }),
        app.prisma.pollVote.findMany({ where: { pollId } }),
      ]);
      return toPollResultsDto(poll, options, votes);
    },
  );

  // -------------------------------------------------------------------------
  // Suggestions
  // -------------------------------------------------------------------------

  app.get(
    '/:guildId/community/suggestions',
    {
      schema: {
        params: guildIdParamSchema,
        querystring: paginationQuerySchema.extend({
          status: z.enum(['PENDING', 'APPROVED', 'DENIED', 'IMPLEMENTED', 'CONSIDERING']).optional(),
        }),
      },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<SuggestionDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit, status } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.suggestion.findMany({
        where: { guildId, deletedAt: null, ...(status ? { status } : {}) },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toSuggestionDto), limit, offset);
    },
  );

  app.patch(
    '/:guildId/community/suggestions/:suggestionId',
    {
      schema: { params: suggestionParamSchema, body: suggestionStatusSchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<SuggestionDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { suggestionId } = request.params as { suggestionId: string };
      const existing = await app.prisma.suggestion.findFirst({
        where: { id: suggestionId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Suggestion not found.');

      const updated = await app.prisma.suggestion.update({
        where: { id: suggestionId },
        data: { status: request.body.status, staffNote: request.body.staffNote },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'community.suggestion.status',
        targetType: 'suggestion',
        targetId: suggestionId,
        before: { status: existing.status },
        after: { status: updated.status },
      });

      // The bot's `community:suggestion-sync` job (runs every minute) picks this DB change up and reflects it
      // into the posted Discord embed — the dashboard never talks to Discord directly.
      return toSuggestionDto(updated);
    },
  );

  // -------------------------------------------------------------------------
  // Announcements
  // -------------------------------------------------------------------------

  app.get(
    '/:guildId/community/announcements',
    {
      schema: { params: guildIdParamSchema, querystring: paginationQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<AnnouncementDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.scheduledAnnouncement.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toAnnouncementDto), limit, offset);
    },
  );

  app.post(
    '/:guildId/community/announcements/:announcementId/cancel',
    { schema: { params: announcementParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<AnnouncementDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { announcementId } = request.params as { announcementId: string };
      const existing = await app.prisma.scheduledAnnouncement.findFirst({
        where: { id: announcementId, guildId },
      });
      if (!existing) throw new NotFoundError('Scheduled announcement not found.');

      const updated = await app.prisma.scheduledAnnouncement.update({
        where: { id: announcementId },
        data: { enabled: false },
      });
      await cancelAnnouncementJob(app.redis, announcementId, existing.cron);

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'community.announcement.cancel',
        targetType: 'scheduled_announcement',
        targetId: announcementId,
      });

      return toAnnouncementDto(updated);
    },
  );

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  app.get(
    '/:guildId/community/events',
    {
      schema: { params: guildIdParamSchema, querystring: paginationQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<CommunityEventDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.communityEvent.findMany({
        where: { guildId },
        orderBy: { startsAt: 'desc' },
        include: { rsvps: true },
        skip: offset,
        take: limit + 1,
      });
      const dtos = rows.map((row) => toCommunityEventDto(row, row.rsvps));
      return buildPaginated(dtos, limit, offset);
    },
  );

  // -------------------------------------------------------------------------
  // Tags (custom commands + auto-responders, spec CG-02). Every write audits and DELs the bot's Redis-cached
  // trigger list for the guild so the auto-responder picks the change up on the next message.
  // -------------------------------------------------------------------------

  app.get(
    '/:guildId/community/tags',
    {
      schema: { params: guildIdParamSchema, querystring: tagListQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<TagDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit, q } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const prefix = q ? q.toLowerCase() : undefined;
      const rows = await app.prisma.tag.findMany({
        where: { guildId, ...(prefix ? { name: { startsWith: prefix } } : {}) },
        orderBy: { name: 'asc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toTagDto), limit, offset);
    },
  );

  app.post(
    '/:guildId/community/tags',
    { schema: { params: guildIdParamSchema, body: tagBodySchema }, preHandler: requireGuildAccess() },
    async (request, reply): Promise<TagDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const body = request.body;

      const existing = await app.prisma.tag.findUnique({
        where: { guildId_name: { guildId, name: body.name } },
        select: { id: true },
      });
      if (existing) throw tagExistsError(body.name);

      const config = await app.configStore.getConfig<{ tags?: { maxTags?: number } }>(
        guildId,
        COMMUNITY_PLUGIN_ID,
      );
      const maxTags = config?.tags?.maxTags ?? DEFAULT_MAX_TAGS;
      const count = await app.prisma.tag.count({ where: { guildId } });
      if (count >= maxTags) {
        throw new AppError('tag_limit', `This server has reached its limit of ${maxTags} tags.`, {
          status: 400,
          expose: true,
        });
      }

      // The check above is a friendly fast path, not the real guarantee — a concurrent create for the same
      // name can still race past it, so the DB's unique constraint (`@@unique([guildId, name])`) is the actual
      // guard; map its P2002 violation to the same 409 a caught-early clash gets (precedent: webhooks.ts's
      // `claimEventOnce`).
      let row;
      try {
        row = await app.prisma.tag.create({
          data: { guildId, ...tagDataFromBody(body), createdBy: session.userId },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw tagExistsError(body.name);
        throw err;
      }

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.CommunityTagCreate,
        targetType: 'tag',
        targetId: row.id,
        after: tagAuditSnapshot(row),
      });
      await app.redis.del(tagTriggersCacheKey(guildId));

      reply.status(201);
      return toTagDto(row);
    },
  );

  app.put(
    '/:guildId/community/tags/:tagId',
    { schema: { params: tagParamSchema, body: tagBodySchema }, preHandler: requireGuildAccess() },
    async (request): Promise<TagDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { tagId } = request.params as { tagId: string };
      const body = request.body;

      const existing = await app.prisma.tag.findFirst({ where: { id: tagId, guildId } });
      if (!existing) throw new NotFoundError('Tag not found.');

      if (body.name !== existing.name) {
        const clash = await app.prisma.tag.findUnique({
          where: { guildId_name: { guildId, name: body.name } },
          select: { id: true },
        });
        if (clash && clash.id !== existing.id) throw tagExistsError(body.name);
      }

      // Same check-then-write race as create: the name-clash lookup above is a fast path, the unique
      // constraint on the write itself is the real guard.
      let updated;
      try {
        updated = await app.prisma.tag.update({
          where: { id: existing.id },
          data: { ...tagDataFromBody(body), updatedBy: session.userId },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw tagExistsError(body.name);
        throw err;
      }

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.CommunityTagUpdate,
        targetType: 'tag',
        targetId: existing.id,
        before: tagAuditSnapshot(existing),
        after: tagAuditSnapshot(updated),
      });
      await app.redis.del(tagTriggersCacheKey(guildId));

      return toTagDto(updated);
    },
  );

  app.delete(
    '/:guildId/community/tags/:tagId',
    { schema: { params: tagParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { tagId } = request.params as { tagId: string };

      const existing = await app.prisma.tag.findFirst({ where: { id: tagId, guildId } });
      if (!existing) throw new NotFoundError('Tag not found.');

      await app.prisma.tag.delete({ where: { id: existing.id } });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.CommunityTagDelete,
        targetType: 'tag',
        targetId: existing.id,
        before: { ...tagAuditSnapshot(existing), uses: existing.uses },
      });
      await app.redis.del(tagTriggersCacheKey(guildId));

      reply.status(204);
      return null;
    },
  );

  // -------------------------------------------------------------------------
  // Sticky messages (list + remove; creating one needs the bot to post, so that stays in Discord: /sticky set)
  // -------------------------------------------------------------------------

  app.get(
    '/:guildId/community/stickies',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<StickyMessageDto[]> => {
      const guildId = request.guildId!;
      const rows = await app.prisma.stickyMessage.findMany({
        where: { guildId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toStickyDto);
    },
  );

  app.delete(
    '/:guildId/community/stickies/:stickyId',
    { schema: { params: stickyParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { stickyId } = request.params as { stickyId: string };
      const existing = await app.prisma.stickyMessage.findFirst({ where: { id: stickyId, guildId } });
      if (!existing) throw new NotFoundError('Sticky message not found.');

      await app.prisma.stickyMessage.delete({ where: { id: stickyId } });
      // The bot's messageCreate handler consults this cached channel set before any DB read — drop it so the
      // channel stops re-posting right away. The bot's last posted copy stays in Discord (the API has no
      // gateway); staff delete it there or run `/sticky remove`.
      await app.redis.del(stickyChannelsKey(guildId));

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.CommunityStickyRemove,
        targetType: 'sticky_message',
        targetId: stickyId,
        before: {
          channelId: existing.channelId,
          content: existing.content,
          cooldownSeconds: existing.cooldownSeconds,
        },
      });
      reply.status(204);
      return null;
    },
  );

  // -------------------------------------------------------------------------
  // Birthdays (spec CG-06) — a summary only, never a paginated table of every member's entry
  // -------------------------------------------------------------------------

  app.get(
    '/:guildId/community/birthdays/summary',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<BirthdaySummaryDto> => {
      const guildId = request.guildId!;
      const [config, guildConfig, count, rows] = await Promise.all([
        app.configStore.getConfig<CommunityConfig>(guildId, COMMUNITY_PLUGIN_ID),
        app.configStore.getGuildConfig(guildId),
        app.prisma.birthday.count({ where: { guildId } }),
        app.prisma.birthday.findMany({
          where: { guildId },
          select: { userId: true, month: true, day: true },
        }),
      ]);
      const today = localNow(guildConfig.timezone);
      const b = config.birthdays;
      return {
        enabled: b.enabled,
        channelId: b.channelId,
        message: b.message,
        announceHour: b.announceHour,
        roleId: b.roleId,
        publicList: b.publicList,
        allowSelfService: b.allowSelfService,
        count,
        next: upcomingSorted(rows, today, BIRTHDAY_NEXT_LIMIT),
      };
    },
  );

  app.put(
    '/:guildId/community/birthdays/config',
    {
      schema: { params: guildIdParamSchema, body: birthdayConfigBodySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<BirthdayConfigDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const before = await app.configStore.getConfig<CommunityConfig>(guildId, COMMUNITY_PLUGIN_ID);
      const updated = await app.configStore.setConfig<CommunityConfig>(
        guildId,
        COMMUNITY_PLUGIN_ID,
        { birthdays: { ...before.birthdays, ...request.body } },
        { id: session.userId, source: 'dashboard' },
      );
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.CommunityBirthdayConfigUpdate,
        targetType: 'plugin_config',
        targetId: COMMUNITY_PLUGIN_ID,
        before: before.birthdays,
        after: updated.birthdays,
      });
      return updated.birthdays;
    },
  );

  app.delete(
    '/:guildId/community/birthdays/:userId',
    { schema: { params: birthdayUserParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply): Promise<void> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { userId } = request.params as { userId: string };
      const result = await app.prisma.birthday.deleteMany({ where: { guildId, userId } });
      if (result.count === 0) throw new NotFoundError('No birthday is set for that member.');
      // Audited with the target user id only — never the date itself.
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.CommunityBirthdayRemove,
        targetType: 'birthday',
        targetId: userId,
      });
      reply.status(204);
    },
  );

  // -------------------------------------------------------------------------
  // Channel automations (auto-publish / auto-threads live in the plugin config; this only exposes the
  // bot-side Redis counter for the dashboard's "published today" stat)
  // -------------------------------------------------------------------------

  app.get(
    '/:guildId/community/channel-automations/stats',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<ChannelAutomationStatsDto> => {
      const raw = await app.redis.get(autoPublishCountKey(request.guildId!, utcDayKey()));
      const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
      return { autoPublishToday: Number.isFinite(parsed) ? parsed : 0 };
    },
  );

  // -------------------------------------------------------------------------
  // Economy settings (economy has no dashboard page of its own — this backs its plugin-config-drawer entry
  // and any other client that wants a typed view instead of the generic plugin-config JSON-schema endpoint)
  // -------------------------------------------------------------------------

  app.get(
    '/:guildId/economy/config',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<EconomySettingsDto> => {
      return app.configStore.getConfig<EconomySettingsDto>(request.guildId!, ECONOMY_PLUGIN_ID);
    },
  );

  app.put(
    '/:guildId/economy/config',
    {
      schema: { params: guildIdParamSchema, body: economySettingsBodySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<EconomySettingsDto> => {
      const session = request.session!;
      return app.configStore.setConfig<EconomySettingsDto>(
        request.guildId!,
        ECONOMY_PLUGIN_ID,
        request.body,
        {
          id: session.userId,
          source: 'dashboard',
        },
      );
    },
  );
}
