import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { AuditAction, NotFoundError, buildPaginated, paginate } from '@pavisie/core';
import { testRuleWithText } from '@pavisie/plugins/automod/test-rule';
import type { AutomodEventDto, AutomodRuleDto, Paginated } from '@pavisie/types';
import { automodActionsSchema, automodRuleConfigSchema } from '../lib/automod-schemas';
import { writeDashboardAudit } from '../lib/audit';
import { toAutomodEventDto, toAutomodRuleDto } from '../lib/dto';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema, paginationQuerySchema } from '../lib/schemas';

const ruleParamSchema = guildIdParamSchema.extend({ ruleId: z.string().min(1) });
const ruleTestBodySchema = z.object({ text: z.string().min(1).max(2000) });
const ruleTestResponseSchema = z.object({
  matched: z.boolean(),
  reason: z.string().optional(),
  evidence: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

const ruleBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  dryRun: z.boolean().default(true),
  config: automodRuleConfigSchema,
  actions: automodActionsSchema,
  exemptRoleIds: z.array(z.string()).default([]),
  exemptChannelIds: z.array(z.string()).default([]),
  exemptUserIds: z.array(z.string()).default([]),
  trustedDomains: z.array(z.string()).default([]),
  cooldownSeconds: z.number().int().min(0).max(86400).default(0),
  priority: z.number().int().min(0).max(1000).default(0),
});
const ruleUpdateBodySchema = ruleBodySchema.partial();

const dryRunToggleSchema = z.object({ dryRun: z.boolean() });

const eventsQuerySchema = paginationQuerySchema.extend({
  reviewStatus: z.enum(['NONE', 'PENDING', 'CONFIRMED', 'FALSE_POSITIVE']).optional(),
});
const eventReviewSchema = z.object({ reviewStatus: z.enum(['CONFIRMED', 'FALSE_POSITIVE']) });
const eventParamSchema = guildIdParamSchema.extend({ eventId: z.string().min(1) });

/** `/guilds/:guildId/automod` — rule builder (CRUD, dry-run toggles) + false-positive review queue (ARCHITECTURE.md §10). */
export default async function automodRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/automod/rules',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<AutomodRuleDto[]> => {
      const guildId = request.guildId!;
      const rows = await app.prisma.automodRule.findMany({
        where: { guildId, deletedAt: null },
        orderBy: { priority: 'asc' },
      });
      return rows.map(toAutomodRuleDto);
    },
  );

  app.post(
    '/:guildId/automod/rules',
    { schema: { params: guildIdParamSchema, body: ruleBodySchema }, preHandler: requireGuildAccess() },
    async (request, reply): Promise<AutomodRuleDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const body = request.body;

      const row = await app.prisma.automodRule.create({
        data: {
          guildId,
          name: body.name,
          type: body.config.type,
          enabled: body.enabled,
          dryRun: body.dryRun,
          config: body.config,
          actions: body.actions,
          exemptRoleIds: body.exemptRoleIds,
          exemptChannelIds: body.exemptChannelIds,
          exemptUserIds: body.exemptUserIds,
          trustedDomains: body.trustedDomains,
          cooldownSeconds: body.cooldownSeconds,
          priority: body.priority,
          createdBy: session.userId,
        },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.AutomodRuleCreate,
        targetType: 'automod_rule',
        targetId: row.id,
        after: { name: row.name, type: row.type, enabled: row.enabled, dryRun: row.dryRun },
      });

      reply.status(201);
      return toAutomodRuleDto(row);
    },
  );

  app.put(
    '/:guildId/automod/rules/:ruleId',
    { schema: { params: ruleParamSchema, body: ruleUpdateBodySchema }, preHandler: requireGuildAccess() },
    async (request): Promise<AutomodRuleDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { ruleId } = request.params as { ruleId: string };
      const existing = await app.prisma.automodRule.findFirst({
        where: { id: ruleId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Automod rule not found.');

      const body = request.body;
      const updated = await app.prisma.automodRule.update({
        where: { id: ruleId },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
          ...(body.config !== undefined ? { config: body.config, type: body.config.type } : {}),
          ...(body.actions !== undefined ? { actions: body.actions } : {}),
          ...(body.exemptRoleIds !== undefined ? { exemptRoleIds: body.exemptRoleIds } : {}),
          ...(body.exemptChannelIds !== undefined ? { exemptChannelIds: body.exemptChannelIds } : {}),
          ...(body.exemptUserIds !== undefined ? { exemptUserIds: body.exemptUserIds } : {}),
          ...(body.trustedDomains !== undefined ? { trustedDomains: body.trustedDomains } : {}),
          ...(body.cooldownSeconds !== undefined ? { cooldownSeconds: body.cooldownSeconds } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
        },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.AutomodRuleUpdate,
        targetType: 'automod_rule',
        targetId: ruleId,
        before: { name: existing.name, enabled: existing.enabled, dryRun: existing.dryRun },
        after: { name: updated.name, enabled: updated.enabled, dryRun: updated.dryRun },
      });

      return toAutomodRuleDto(updated);
    },
  );

  app.delete(
    '/:guildId/automod/rules/:ruleId',
    { schema: { params: ruleParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { ruleId } = request.params as { ruleId: string };
      const existing = await app.prisma.automodRule.findFirst({
        where: { id: ruleId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Automod rule not found.');

      await app.prisma.automodRule.update({ where: { id: ruleId }, data: { deletedAt: new Date() } });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.AutomodRuleDelete,
        targetType: 'automod_rule',
        targetId: ruleId,
      });
      reply.status(204);
      return null;
    },
  );

  app.post(
    '/:guildId/automod/rules/:ruleId/dry-run',
    { schema: { params: ruleParamSchema, body: dryRunToggleSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<AutomodRuleDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { ruleId } = request.params as { ruleId: string };
      const existing = await app.prisma.automodRule.findFirst({
        where: { id: ruleId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Automod rule not found.');

      const updated = await app.prisma.automodRule.update({
        where: { id: ruleId },
        data: { dryRun: request.body.dryRun },
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.AutomodRuleUpdate,
        targetType: 'automod_rule',
        targetId: ruleId,
        before: { dryRun: existing.dryRun },
        after: { dryRun: updated.dryRun },
      });
      return toAutomodRuleDto(updated);
    },
  );

  app.post(
    '/:guildId/automod/dry-run',
    { schema: { params: guildIdParamSchema, body: dryRunToggleSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const result = await app.prisma.automodRule.updateMany({
        where: { guildId, deletedAt: null },
        data: { dryRun: request.body.dryRun },
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.AutomodRuleUpdate,
        targetType: 'automod_rule',
        targetId: 'guild-wide',
        after: { dryRun: request.body.dryRun, rulesAffected: result.count },
      });
      return { ok: true, rulesAffected: result.count };
    },
  );

  app.get(
    '/:guildId/automod/events',
    {
      schema: { params: guildIdParamSchema, querystring: eventsQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<AutomodEventDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit, reviewStatus } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.automodEvent.findMany({
        where: { guildId, ...(reviewStatus ? { reviewStatus } : {}) },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toAutomodEventDto), limit, offset);
    },
  );

  app.patch(
    '/:guildId/automod/events/:eventId/review',
    { schema: { params: eventParamSchema, body: eventReviewSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<AutomodEventDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { eventId } = request.params as { eventId: string };
      const existing = await app.prisma.automodEvent.findFirst({ where: { id: eventId, guildId } });
      if (!existing) throw new NotFoundError('Automod event not found.');

      const updated = await app.prisma.automodEvent.update({
        where: { id: eventId },
        data: { reviewStatus: request.body.reviewStatus, reviewedBy: session.userId, reviewedAt: new Date() },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.AutomodEventReview,
        targetType: 'automod_event',
        targetId: eventId,
        after: { reviewStatus: updated.reviewStatus },
      });

      return toAutomodEventDto(updated);
    },
  );

  app.post(
    '/:guildId/automod/rules/:ruleId/test',
    {
      schema: {
        params: ruleParamSchema,
        body: ruleTestBodySchema,
        response: { 200: ruleTestResponseSchema },
      },
      preHandler: requireGuildAccess(),
    },
    async (request) => {
      const guildId = request.guildId!;
      const { ruleId } = request.params as { ruleId: string };
      const existing = await app.prisma.automodRule.findFirst({
        where: { id: ruleId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Automod rule not found.');

      const config = automodRuleConfigSchema.parse(existing.config);
      const result = await testRuleWithText(config, request.body.text, { guildId });

      return {
        matched: result.matched,
        reason: result.reason,
        evidence: result.evidence as Record<string, string | number | boolean | null> | undefined,
      };
    },
  );
}
