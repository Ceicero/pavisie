import type { ZodFastifyInstance } from '../lib/http';
import { NotFoundError, buildPaginated, paginate } from '@pavisie/core';
import { evaluate, type NormalizedMessage, type Policy } from '@pavisie/plugins/enforcer/engine';
import { extractInvites, extractLinks } from '@pavisie/plugins/enforcer/normalize';
import type { EnforcerConfig } from '@pavisie/plugins/enforcer/manifest';
import type { EnforcerPolicyDto, EnforcerRecordDto, Paginated } from '@pavisie/types';
import { writeDashboardAudit } from '../lib/audit';
import { toCsv } from '../lib/csv';
import { toEnforcerPolicyDto, toEnforcerRecordDto, toEnforcerSettingsDto } from '../lib/enforcer/dto';
import {
  decideBodySchema,
  enforcerSettingsPatchSchema,
  policyBodySchema,
  policyParamSchema,
  policyTestBodySchema,
  policyUpdateBodySchema,
  recordParamSchema,
  recordsQuerySchema,
} from '../lib/enforcer/schemas';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema } from '../lib/schemas';
import { buildRecordSearchWhere } from '@pavisie/plugins/enforcer/search-filters';

const ENFORCER_PLUGIN_ID = 'enforcer' as const;

function toPolicyEngineShape(row: {
  id: string;
  name: string;
  enabled: boolean;
  severity: string;
  matchers: unknown;
  channelIds: string[];
  exemptRoleIds: string[];
  exemptChannelIds: string[];
}): Policy {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    severity: row.severity as Policy['severity'],
    matchers: row.matchers as Policy['matchers'],
    channelIds: row.channelIds,
    exemptRoleIds: row.exemptRoleIds,
    exemptChannelIds: row.exemptChannelIds,
  };
}

/** `/guilds/:guildId/enforcer` — settings, policy CRUD + test, records list/get/decide/export, pending-flag queue (ARCHITECTURE.md §19). */
export default async function enforcerRoutes(app: ZodFastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------

  app.get(
    '/:guildId/enforcer/settings',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const config = await app.configStore.getConfig<EnforcerConfig>(request.guildId!, ENFORCER_PLUGIN_ID);
      return toEnforcerSettingsDto(config);
    },
  );

  app.put(
    '/:guildId/enforcer/settings',
    {
      schema: { params: guildIdParamSchema, body: enforcerSettingsPatchSchema },
      preHandler: requireGuildAccess(),
    },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const config = await app.configStore.setConfig<EnforcerConfig>(
        guildId,
        ENFORCER_PLUGIN_ID,
        request.body,
        { id: session.userId, source: 'dashboard' },
      );
      return toEnforcerSettingsDto(config);
    },
  );

  // ---------------------------------------------------------------------
  // Policies
  // ---------------------------------------------------------------------

  app.get(
    '/:guildId/enforcer/policies',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<EnforcerPolicyDto[]> => {
      const rows = await app.prisma.enforcerPolicy.findMany({
        where: { guildId: request.guildId!, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toEnforcerPolicyDto);
    },
  );

  app.post(
    '/:guildId/enforcer/policies',
    { schema: { params: guildIdParamSchema, body: policyBodySchema }, preHandler: requireGuildAccess() },
    async (request, reply): Promise<EnforcerPolicyDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const body = request.body;

      const row = await app.prisma.enforcerPolicy.create({
        data: {
          guildId,
          name: body.name,
          description: body.description,
          enabled: body.enabled,
          severity: body.severity,
          matchers: body.matchers,
          channelIds: body.channelIds,
          exemptRoleIds: body.exemptRoleIds,
          exemptChannelIds: body.exemptChannelIds,
          suggestedAction: body.suggestedAction,
          createdBy: session.userId,
        },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'enforcer.policy.create',
        targetType: 'enforcer_policy',
        targetId: row.id,
        after: { name: row.name, severity: row.severity },
      });

      reply.status(201);
      return toEnforcerPolicyDto(row);
    },
  );

  app.get(
    '/:guildId/enforcer/policies/:policyId',
    { schema: { params: policyParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<EnforcerPolicyDto> => {
      const { guildId, policyId } = request.params as { guildId: string; policyId: string };
      const row = await app.prisma.enforcerPolicy.findFirst({
        where: { id: policyId, guildId, deletedAt: null },
      });
      if (!row) throw new NotFoundError('Policy not found.');
      return toEnforcerPolicyDto(row);
    },
  );

  app.put(
    '/:guildId/enforcer/policies/:policyId',
    { schema: { params: policyParamSchema, body: policyUpdateBodySchema }, preHandler: requireGuildAccess() },
    async (request): Promise<EnforcerPolicyDto> => {
      const { guildId, policyId } = request.params as { guildId: string; policyId: string };
      const session = request.session!;
      const existing = await app.prisma.enforcerPolicy.findFirst({
        where: { id: policyId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Policy not found.');

      const body = request.body;
      const updated = await app.prisma.enforcerPolicy.update({
        where: { id: policyId },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.severity !== undefined ? { severity: body.severity } : {}),
          ...(body.matchers !== undefined ? { matchers: body.matchers } : {}),
          ...(body.channelIds !== undefined ? { channelIds: body.channelIds } : {}),
          ...(body.exemptRoleIds !== undefined ? { exemptRoleIds: body.exemptRoleIds } : {}),
          ...(body.exemptChannelIds !== undefined ? { exemptChannelIds: body.exemptChannelIds } : {}),
          ...(body.suggestedAction !== undefined ? { suggestedAction: body.suggestedAction } : {}),
          updatedBy: session.userId,
        },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'enforcer.policy.update',
        targetType: 'enforcer_policy',
        targetId: policyId,
        before: { name: existing.name, enabled: existing.enabled },
        after: { name: updated.name, enabled: updated.enabled },
      });

      return toEnforcerPolicyDto(updated);
    },
  );

  app.delete(
    '/:guildId/enforcer/policies/:policyId',
    { schema: { params: policyParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const { guildId, policyId } = request.params as { guildId: string; policyId: string };
      const session = request.session!;
      const existing = await app.prisma.enforcerPolicy.findFirst({
        where: { id: policyId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Policy not found.');

      await app.prisma.enforcerPolicy.update({ where: { id: policyId }, data: { deletedAt: new Date() } });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'enforcer.policy.delete',
        targetType: 'enforcer_policy',
        targetId: policyId,
      });
      reply.status(204);
      return null;
    },
  );

  app.post(
    '/:guildId/enforcer/policies/:policyId/test',
    { schema: { params: policyParamSchema, body: policyTestBodySchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const { guildId, policyId } = request.params as { guildId: string; policyId: string };
      const row = await app.prisma.enforcerPolicy.findFirst({
        where: { id: policyId, guildId, deletedAt: null },
      });
      if (!row) throw new NotFoundError('Policy not found.');

      const text = request.body.text;
      const message: NormalizedMessage = {
        content: text,
        authorId: 'test',
        authorRoleIds: [],
        channelId: 'test',
        mentionsCount: 0,
        attachments: [],
        links: extractLinks(text),
        invites: extractInvites(text),
        isStaff: false,
      };
      const matches = evaluate(message, [toPolicyEngineShape(row)]);
      return { matched: matches.length > 0, matches };
    },
  );

  // ---------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------

  app.get(
    '/:guildId/enforcer/records',
    {
      schema: { params: guildIdParamSchema, querystring: recordsQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<EnforcerRecordDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit, userId, kind, decision, status, policyId, since } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });

      const where = buildRecordSearchWhere({ guildId, userId, kind, decision, status, policyId, since });

      const rows = await app.prisma.enforcerRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toEnforcerRecordDto), limit, offset);
    },
  );

  app.get(
    '/:guildId/enforcer/records/export.csv',
    {
      schema: { params: guildIdParamSchema, querystring: recordsQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request, reply) => {
      const guildId = request.guildId!;
      const { userId, kind, decision, status, policyId, since } = request.query;
      const where = buildRecordSearchWhere({ guildId, userId, kind, decision, status, policyId, since });

      const rows = await app.prisma.enforcerRecord.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: 10000,
      });
      const csv = toCsv(
        rows.map((row) => ({
          recordNumber: row.recordNumber,
          kind: row.kind,
          status: row.status ?? '',
          userId: row.userId,
          policyName: row.policyName ?? '',
          source: row.source,
          decision: row.decision ?? '',
          decidedBy: row.decidedBy ?? '',
          decisionReason: row.decisionReason ?? '',
          caseId: row.caseId ?? '',
          excerpt: row.excerpt ?? '',
          createdAt: row.createdAt.toISOString(),
        })),
        [
          'recordNumber',
          'kind',
          'status',
          'userId',
          'policyName',
          'source',
          'decision',
          'decidedBy',
          'decisionReason',
          'caseId',
          'excerpt',
          'createdAt',
        ],
      );
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="enforcer-records-${guildId}.csv"`);
      return reply.send(csv);
    },
  );

  app.get(
    '/:guildId/enforcer/queue',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<EnforcerRecordDto[]> => {
      const rows = await app.prisma.enforcerRecord.findMany({
        where: { guildId: request.guildId!, kind: 'FLAG', status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      return rows.map(toEnforcerRecordDto);
    },
  );

  app.get(
    '/:guildId/enforcer/records/:recordNumber',
    { schema: { params: recordParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<EnforcerRecordDto> => {
      const { guildId, recordNumber } = request.params as { guildId: string; recordNumber: number };
      const row = await app.prisma.enforcerRecord.findUnique({
        where: { guildId_recordNumber: { guildId, recordNumber } },
      });
      if (!row) throw new NotFoundError('Record not found.');
      return toEnforcerRecordDto(row);
    },
  );

  app.post(
    '/:guildId/enforcer/records/:recordNumber/decide',
    { schema: { params: recordParamSchema, body: decideBodySchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const { guildId, recordNumber } = request.params as { guildId: string; recordNumber: number };
      const session = request.session!;

      const record = await app.prisma.enforcerRecord.findUnique({
        where: { guildId_recordNumber: { guildId, recordNumber } },
      });
      if (!record || record.kind !== 'FLAG') throw new NotFoundError('Flag record not found.');

      await app.queues.botActions().add('bot-action', {
        type: 'enforcer.decide',
        guildId,
        payload: {
          recordId: record.id,
          decision: request.body.decision,
          reason: request.body.reason,
          durationMs: request.body.durationMs,
          banDeleteMessageSeconds: request.body.banDeleteMessageSeconds,
        },
        requestedBy: session.userId,
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'enforcer.decision.request',
        targetType: 'enforcer_record',
        targetId: record.id,
        after: { decision: request.body.decision, reason: request.body.reason },
      });

      return { queued: true };
    },
  );
}
