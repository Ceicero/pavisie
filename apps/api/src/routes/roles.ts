import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { AuditAction, NotFoundError, buildPaginated, paginate } from '@pavisie/core';
import type { RolesConfig } from '@pavisie/plugins/roles/manifest';
import type { Paginated, RolePanelDto } from '@pavisie/types';
import type {
  AutoRolesDto,
  OnboardingConfigDto,
  RoleGroupDto,
  RolePersistenceDto,
  VerificationRequestDto,
  VerificationSettingsDto,
  WelcomeGoodbyeDto,
} from '@pavisie/types/roles';
import { writeDashboardAudit } from '../lib/audit';
import { toRolePanelDto } from '../lib/dto';
import {
  toOnboardingConfigDto,
  toRoleGroupDto,
  toVerificationRequestDto,
  toWelcomeGoodbyeDto,
} from '../lib/roles/dto';
import {
  autoRolesBodySchema,
  groupBodySchema,
  groupParamSchema,
  groupUpdateSchema,
  onboardingConfigBodySchema,
  persistenceBodySchema,
  testMessageBodySchema,
  verificationSettingsBodySchema,
  welcomeGoodbyeBodySchema,
} from '../lib/roles/schemas';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema, paginationQuerySchema } from '../lib/schemas';

const ROLES_PLUGIN_ID = 'roles' as const;
const ROLE_PERSISTENCE_DISCLOSURE =
  "When on, Pavisie stores a snapshot of a leaving member's roles (excluding elevated-permission and integration-managed roles) for up to the configured number of days, and restores them automatically if that member rejoins within that window.";
/** The API has no gateway connection, so it cannot check role hierarchy/permissions; the bot re-validates at assignment time (`grantAutoRoles`) and records skips in the `roles.autorole.apply` audit row. */
const AUTO_ROLES_NOTE =
  'Roles are re-checked at assignment time; elevated/managed/higher-than-bot roles are skipped and logged.';

function toAutoRolesDto(config: RolesConfig): AutoRolesDto {
  return {
    enabled: config.autoRoles.enabled,
    roleIds: config.autoRoles.roleIds,
    botRoleIds: config.autoRoles.botRoleIds,
    delaySeconds: config.autoRoles.delaySeconds,
    note: AUTO_ROLES_NOTE,
  };
}

const panelOptionSchema = z.object({
  roleId: z.string().min(1),
  label: z.string().trim().min(1).max(100),
  emoji: z.string().max(64).nullable().optional(),
  description: z.string().trim().max(200).nullable().optional(),
  position: z.number().int().min(0).default(0),
});

const panelBodySchema = z.object({
  channelId: z.string().min(1),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).nullable().optional(),
  style: z.enum(['BUTTONS', 'SELECT', 'REACTIONS']),
  groupId: z.string().nullable().optional(),
  maxSelections: z.number().int().positive().nullable().optional(),
  options: z.array(panelOptionSchema).min(1).max(25),
});
const panelUpdateSchema = panelBodySchema.partial();
const panelParamSchema = guildIdParamSchema.extend({ panelId: z.string().min(1) });

const verificationParamSchema = guildIdParamSchema.extend({ requestId: z.string().min(1) });
const verificationDecisionSchema = z.object({ note: z.string().trim().max(1000).optional() });

async function getRolesConfig(app: ZodFastifyInstance, guildId: string): Promise<RolesConfig> {
  return app.configStore.getConfig<RolesConfig>(guildId, ROLES_PLUGIN_ID);
}

/** `/guilds/:guildId/roles` — role panel builder, groups, welcome/goodbye config, onboarding, persistence, and verification (ARCHITECTURE.md §10). */
export default async function rolesRoutes(app: ZodFastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------------------------------------
  // Panels
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/roles/panels',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<RolePanelDto[]> => {
      const rows = await app.prisma.rolePanel.findMany({
        where: { guildId: request.guildId!, deletedAt: null },
        include: { options: { orderBy: { position: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toRolePanelDto);
    },
  );

  app.post(
    '/:guildId/roles/panels',
    { schema: { params: guildIdParamSchema, body: panelBodySchema }, preHandler: requireGuildAccess() },
    async (request, reply): Promise<RolePanelDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { options, ...panelFields } = request.body;

      const row = await app.prisma.rolePanel.create({
        data: {
          guildId,
          ...panelFields,
          options: { create: options.map((opt, index) => ({ ...opt, position: opt.position ?? index })) },
        },
        include: { options: { orderBy: { position: 'asc' } } },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.RolesPanelCreate,
        targetType: 'role_panel',
        targetId: row.id,
        after: { title: row.title },
      });
      reply.status(201);
      return toRolePanelDto(row);
    },
  );

  app.put(
    '/:guildId/roles/panels/:panelId',
    { schema: { params: panelParamSchema, body: panelUpdateSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<RolePanelDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { panelId } = request.params as { panelId: string };
      const existing = await app.prisma.rolePanel.findFirst({
        where: { id: panelId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Role panel not found.');

      const { options, ...panelFields } = request.body;
      if (options) {
        await app.prisma.rolePanelOption.deleteMany({ where: { panelId } });
      }

      const updated = await app.prisma.rolePanel.update({
        where: { id: panelId },
        data: {
          ...panelFields,
          ...(options
            ? {
                options: {
                  create: options.map((opt, index) => ({ ...opt, position: opt.position ?? index })),
                },
              }
            : {}),
        },
        include: { options: { orderBy: { position: 'asc' } } },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.RolesPanelUpdate,
        targetType: 'role_panel',
        targetId: panelId,
      });
      return toRolePanelDto(updated);
    },
  );

  app.delete(
    '/:guildId/roles/panels/:panelId',
    { schema: { params: panelParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { panelId } = request.params as { panelId: string };
      const existing = await app.prisma.rolePanel.findFirst({
        where: { id: panelId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Role panel not found.');

      await app.prisma.rolePanel.update({ where: { id: panelId }, data: { deletedAt: new Date() } });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.RolesPanelDelete,
        targetType: 'role_panel',
        targetId: panelId,
      });
      reply.status(204);
      return null;
    },
  );

  app.post(
    '/:guildId/roles/panels/:panelId/post',
    { schema: { params: panelParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { panelId } = request.params as { panelId: string };
      const existing = await app.prisma.rolePanel.findFirst({
        where: { id: panelId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Role panel not found.');

      await app.queues
        .botActions()
        .add('bot-action', {
          type: 'roles.postPanel',
          guildId,
          payload: { panelId },
          requestedBy: session.userId,
        });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'roles.panel.post',
        targetType: 'role_panel',
        targetId: panelId,
      });
      return { ok: true, queued: true };
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Groups
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/roles/groups',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<RoleGroupDto[]> => {
      const rows = await app.prisma.roleGroup.findMany({
        where: { guildId: request.guildId! },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toRoleGroupDto);
    },
  );

  app.post(
    '/:guildId/roles/groups',
    { schema: { params: guildIdParamSchema, body: groupBodySchema }, preHandler: requireGuildAccess() },
    async (request, reply): Promise<RoleGroupDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const row = await app.prisma.roleGroup.create({ data: { guildId, ...request.body } });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'roles.group.create',
        targetType: 'role_group',
        targetId: row.id,
        after: { name: row.name },
      });
      reply.status(201);
      return toRoleGroupDto(row);
    },
  );

  app.put(
    '/:guildId/roles/groups/:groupId',
    { schema: { params: groupParamSchema, body: groupUpdateSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<RoleGroupDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { groupId } = request.params as { groupId: string };
      const existing = await app.prisma.roleGroup.findFirst({ where: { id: groupId, guildId } });
      if (!existing) throw new NotFoundError('Role group not found.');

      const updated = await app.prisma.roleGroup.update({ where: { id: groupId }, data: request.body });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'roles.group.update',
        targetType: 'role_group',
        targetId: groupId,
      });
      return toRoleGroupDto(updated);
    },
  );

  app.delete(
    '/:guildId/roles/groups/:groupId',
    { schema: { params: groupParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { groupId } = request.params as { groupId: string };
      const existing = await app.prisma.roleGroup.findFirst({ where: { id: groupId, guildId } });
      if (!existing) throw new NotFoundError('Role group not found.');

      await app.prisma.rolePanel.updateMany({ where: { guildId, groupId }, data: { groupId: null } });
      await app.prisma.roleGroup.delete({ where: { id: groupId } });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'roles.group.delete',
        targetType: 'role_group',
        targetId: groupId,
      });
      reply.status(204);
      return null;
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Welcome / goodbye
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/roles/welcome',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<WelcomeGoodbyeDto> => {
      const config = await getRolesConfig(app, request.guildId!);
      return toWelcomeGoodbyeDto(config.welcome);
    },
  );

  app.put(
    '/:guildId/roles/welcome',
    {
      schema: { params: guildIdParamSchema, body: welcomeGoodbyeBodySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<WelcomeGoodbyeDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const current = await getRolesConfig(app, guildId);
      const updated = await app.configStore.setConfig<RolesConfig>(
        guildId,
        ROLES_PLUGIN_ID,
        { welcome: { ...current.welcome, ...request.body } },
        { id: session.userId, source: 'dashboard' },
      );
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.RolesWelcomeUpdate,
        targetType: 'plugin_config',
        targetId: ROLES_PLUGIN_ID,
      });
      return toWelcomeGoodbyeDto(updated.welcome);
    },
  );

  app.post(
    '/:guildId/roles/welcome/test',
    { schema: { params: guildIdParamSchema, body: testMessageBodySchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      await app.queues
        .botActions()
        .add('bot-action', {
          type: 'roles.testWelcome',
          guildId,
          payload: { channelId: request.body.channelId, section: 'welcome' },
          requestedBy: session.userId,
        });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'roles.welcome.test',
        targetType: 'plugin_config',
        targetId: ROLES_PLUGIN_ID,
      });
      return { ok: true, queued: true };
    },
  );

  app.get(
    '/:guildId/roles/goodbye',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<WelcomeGoodbyeDto> => {
      const config = await getRolesConfig(app, request.guildId!);
      return toWelcomeGoodbyeDto(config.goodbye);
    },
  );

  app.put(
    '/:guildId/roles/goodbye',
    {
      schema: { params: guildIdParamSchema, body: welcomeGoodbyeBodySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<WelcomeGoodbyeDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const current = await getRolesConfig(app, guildId);
      const updated = await app.configStore.setConfig<RolesConfig>(
        guildId,
        ROLES_PLUGIN_ID,
        { goodbye: { ...current.goodbye, ...request.body } },
        { id: session.userId, source: 'dashboard' },
      );
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.RolesWelcomeUpdate,
        targetType: 'plugin_config',
        targetId: ROLES_PLUGIN_ID,
      });
      return toWelcomeGoodbyeDto(updated.goodbye);
    },
  );

  app.post(
    '/:guildId/roles/goodbye/test',
    { schema: { params: guildIdParamSchema, body: testMessageBodySchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      await app.queues
        .botActions()
        .add('bot-action', {
          type: 'roles.testWelcome',
          guildId,
          payload: { channelId: request.body.channelId, section: 'goodbye' },
          requestedBy: session.userId,
        });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'roles.goodbye.test',
        targetType: 'plugin_config',
        targetId: ROLES_PLUGIN_ID,
      });
      return { ok: true, queued: true };
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Verification
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/roles/verification/settings',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<VerificationSettingsDto> => {
      const config = await getRolesConfig(app, request.guildId!);
      return config.verification;
    },
  );

  app.put(
    '/:guildId/roles/verification/settings',
    {
      schema: { params: guildIdParamSchema, body: verificationSettingsBodySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<VerificationSettingsDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const current = await getRolesConfig(app, guildId);
      const updated = await app.configStore.setConfig<RolesConfig>(
        guildId,
        ROLES_PLUGIN_ID,
        { verification: { ...current.verification, ...request.body } },
        { id: session.userId, source: 'dashboard' },
      );
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'verification.settings.update',
        targetType: 'plugin_config',
        targetId: ROLES_PLUGIN_ID,
      });
      return updated.verification;
    },
  );

  app.get(
    '/:guildId/roles/verification/queue',
    {
      schema: { params: guildIdParamSchema, querystring: paginationQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<VerificationRequestDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.verificationRequest.findMany({
        where: { guildId, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toVerificationRequestDto), limit, offset);
    },
  );

  // Kept for backward compatibility with the prep-stage shape (`GET /:guildId/roles/verification`).
  app.get(
    '/:guildId/roles/verification',
    {
      schema: { params: guildIdParamSchema, querystring: paginationQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<Paginated<VerificationRequestDto>> => {
      const guildId = request.guildId!;
      const { cursor, limit: rawLimit } = request.query;
      const { limit, offset } = paginate({ cursor, limit: rawLimit });
      const rows = await app.prisma.verificationRequest.findMany({
        where: { guildId, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        skip: offset,
        take: limit + 1,
      });
      return buildPaginated(rows.map(toVerificationRequestDto), limit, offset);
    },
  );

  app.post(
    '/:guildId/roles/verification/:requestId/decide',
    {
      schema: {
        params: verificationParamSchema,
        body: verificationDecisionSchema.extend({ approve: z.boolean() }),
      },
      preHandler: requireGuildAccess(),
    },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { requestId } = request.params as { requestId: string };
      const existing = await app.prisma.verificationRequest.findFirst({ where: { id: requestId, guildId } });
      if (!existing) throw new NotFoundError('Verification request not found.');

      await app.queues.botActions().add('bot-action', {
        type: 'roles.verificationDecision',
        guildId,
        payload: { requestId, approve: request.body.approve, note: request.body.note },
        requestedBy: session.userId,
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: request.body.approve ? AuditAction.VerificationApprove : AuditAction.VerificationDeny,
        targetType: 'verification_request',
        targetId: requestId,
      });
      return { ok: true, queued: true };
    },
  );

  app.post(
    '/:guildId/roles/verification/:requestId/approve',
    {
      schema: { params: verificationParamSchema, body: verificationDecisionSchema },
      preHandler: requireGuildAccess(),
    },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { requestId } = request.params as { requestId: string };
      const existing = await app.prisma.verificationRequest.findFirst({ where: { id: requestId, guildId } });
      if (!existing) throw new NotFoundError('Verification request not found.');

      await app.queues
        .botActions()
        .add('bot-action', {
          type: 'roles.verificationDecision',
          guildId,
          payload: { requestId, approve: true, note: request.body.note },
          requestedBy: session.userId,
        });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.VerificationApprove,
        targetType: 'verification_request',
        targetId: requestId,
      });
      return { ok: true, queued: true };
    },
  );

  app.post(
    '/:guildId/roles/verification/:requestId/deny',
    {
      schema: { params: verificationParamSchema, body: verificationDecisionSchema },
      preHandler: requireGuildAccess(),
    },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { requestId } = request.params as { requestId: string };
      const existing = await app.prisma.verificationRequest.findFirst({ where: { id: requestId, guildId } });
      if (!existing) throw new NotFoundError('Verification request not found.');

      await app.queues
        .botActions()
        .add('bot-action', {
          type: 'roles.verificationDecision',
          guildId,
          payload: { requestId, approve: false, note: request.body.note },
          requestedBy: session.userId,
        });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.VerificationDeny,
        targetType: 'verification_request',
        targetId: requestId,
      });
      return { ok: true, queued: true };
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Onboarding
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/roles/onboarding',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<OnboardingConfigDto> => {
      const config = await getRolesConfig(app, request.guildId!);
      return toOnboardingConfigDto(config);
    },
  );

  app.put(
    '/:guildId/roles/onboarding',
    {
      schema: { params: guildIdParamSchema, body: onboardingConfigBodySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<OnboardingConfigDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const updated = await app.configStore.setConfig<RolesConfig>(guildId, ROLES_PLUGIN_ID, request.body, {
        id: session.userId,
        source: 'dashboard',
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'onboarding.config.update',
        targetType: 'plugin_config',
        targetId: ROLES_PLUGIN_ID,
      });
      return toOnboardingConfigDto(updated);
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Role persistence
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/roles/persistence',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<RolePersistenceDto & { disclosure: string }> => {
      const config = await getRolesConfig(app, request.guildId!);
      return { ...config.rolePersistence, disclosure: ROLE_PERSISTENCE_DISCLOSURE };
    },
  );

  app.post(
    '/:guildId/roles/persistence',
    { schema: { params: guildIdParamSchema, body: persistenceBodySchema }, preHandler: requireGuildAccess() },
    async (request): Promise<RolePersistenceDto & { disclosure: string }> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const current = await getRolesConfig(app, guildId);

      const updated = await app.configStore.setConfig<RolesConfig>(
        guildId,
        ROLES_PLUGIN_ID,
        {
          rolePersistence: {
            enabled: request.body.enabled,
            maxDays: request.body.maxDays ?? current.rolePersistence.maxDays,
          },
        },
        { id: session.userId, source: 'dashboard' },
      );

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'roles.persistence.toggle',
        targetType: 'plugin_config',
        targetId: ROLES_PLUGIN_ID,
        after: {
          enabled: updated.rolePersistence.enabled,
          maxDays: updated.rolePersistence.maxDays,
          acknowledgedDisclosure: request.body.acknowledge ?? false,
        },
      });

      return { ...updated.rolePersistence, disclosure: ROLE_PERSISTENCE_DISCLOSURE };
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Auto-roles on join
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/roles/autoroles',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<AutoRolesDto> => {
      const config = await getRolesConfig(app, request.guildId!);
      return toAutoRolesDto(config);
    },
  );

  app.put(
    '/:guildId/roles/autoroles',
    { schema: { params: guildIdParamSchema, body: autoRolesBodySchema }, preHandler: requireGuildAccess() },
    async (request): Promise<AutoRolesDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const current = await getRolesConfig(app, guildId);

      const updated = await app.configStore.setConfig<RolesConfig>(
        guildId,
        ROLES_PLUGIN_ID,
        {
          autoRoles: {
            enabled: request.body.enabled ?? current.autoRoles.enabled,
            roleIds: request.body.roleIds ?? current.autoRoles.roleIds,
            botRoleIds: request.body.botRoleIds ?? current.autoRoles.botRoleIds,
            delaySeconds: request.body.delaySeconds ?? current.autoRoles.delaySeconds,
          },
        },
        { id: session.userId, source: 'dashboard' },
      );

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.RolesAutoRoleUpdate,
        targetType: 'plugin_config',
        targetId: ROLES_PLUGIN_ID,
        before: {
          enabled: current.autoRoles.enabled,
          roleIds: current.autoRoles.roleIds,
          botRoleIds: current.autoRoles.botRoleIds,
          delaySeconds: current.autoRoles.delaySeconds,
        },
        after: {
          enabled: updated.autoRoles.enabled,
          roleIds: updated.autoRoles.roleIds,
          botRoleIds: updated.autoRoles.botRoleIds,
          delaySeconds: updated.autoRoles.delaySeconds,
        },
      });

      return toAutoRolesDto(updated);
    },
  );
}
