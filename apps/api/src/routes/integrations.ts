import { randomBytes } from 'node:crypto';
import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import {
  AuditAction,
  ExternalServiceError,
  NotFoundError,
  ValidationError,
  assertPublicHttpUrl,
  encryptSecret,
  env,
  redisKey,
} from '@pavisie/core';
import type { WebhookEndpointDto } from '@pavisie/types';
import type {
  IntegrationConnectionDetailDto,
  IntegrationLiveStatusDto,
  IntegrationProviderInfoDto,
  WebhookDeliveryDto,
  WebhookEndpointDetailDto,
} from '@pavisie/types/integrations';
import { writeDashboardAudit } from '../lib/audit';
import { toIntegrationConnectionDto, toWebhookEndpointDto } from '../lib/dto';
import {
  toIntegrationConnectionDetailDto,
  toWebhookDeliveryDto,
  toWebhookEndpointDetailDto,
} from '../lib/integrations/dto';
import { fetchTwitchLiveStatuses, twitchLiveStatusContextFrom } from '../lib/integrations/live-status';
import { requireGuildAccess } from '../lib/guild-access';
import {
  ALERT_PROVIDER_IDS,
  CANONICAL_PROVIDER_ENUM_MAP,
  OAUTH_PROVIDER_IDS,
  PROVIDER_ENUM_MAP,
  WEBHOOK_PROVIDER_IDS,
  buildProviderAuthorizeUrl,
  isOAuthProvider,
  isOAuthProviderConfigured,
  isWebhookProvider,
  listProviderAvailability,
  type AlertProviderId,
  type IntegrationProviderId,
} from '../lib/integrations/providers';
import { OUTBOUND_PLATFORM_EVENTS } from '../lib/integrations/outbound-events';
import { guildIdParamSchema, snowflakeSchema } from '../lib/schemas';

const ALL_PROVIDER_IDS = [...OAUTH_PROVIDER_IDS, ...WEBHOOK_PROVIDER_IDS] as [
  IntegrationProviderId,
  ...IntegrationProviderId[],
];
const providerParamSchema = guildIdParamSchema.extend({ provider: z.enum(ALL_PROVIDER_IDS) });
const connectionParamSchema = guildIdParamSchema.extend({ connectionId: z.string().min(1) });
const endpointParamSchema = guildIdParamSchema.extend({ endpointId: z.string().min(1) });
const webhookCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.string().trim().max(50).default('generic'),
  events: z.array(z.string()).default([]),
  channelId: z.string().nullable().optional(),
});

// `generic_webhook` is the only remaining `WebhookProviderId` (github/stripe were removed as connectable
// providers 2026-09-02) — this always resolves to the generic inbound path, but stays a named function/callsite
// (rather than inlining the template string) so a future webhook-kind provider with its own dedicated inbound
// path is a one-line change here, not a hunt through `routes/integrations.ts`.
function webhookPathFor(endpointId: string): string {
  return `/webhooks/generic/${endpointId}`;
}

/** True when `config` is the shape the twitch-chat OAuth callback stamps onto a connection (`{ kind: 'chat' }`
 * — see `oauth-integrations.ts`). Such a connection belongs entirely to `TwitchChatChannel`/`routes/twitch-chat.ts`
 * and must never surface as a generic connection or an alert watch — it carries none of the fields either UI
 * expects, and disconnecting/deleting one out from under its `TwitchChatChannel` silently breaks the chat
 * integration (the channel keeps its `connectionId`, now pointing at a dead connection). */
function isChatKindConnection(config: unknown): boolean {
  return Boolean(config && typeof config === 'object' && (config as Record<string, unknown>).kind === 'chat');
}

/**
 * IDs of every chat-kind connection (see `isChatKindConnection`) in `guildId`, for excluding them from list
 * queries via `id: { notIn }`. Deliberately not a negated JSON-path `where` filter (e.g.
 * `NOT: { config: { path: ['kind'], equals: 'chat' } }`): Postgres's JSON path extraction returns SQL NULL for
 * a `config` that never had a `kind` key at all — which is every normal connection, generic or alert — and
 * NULL fails a negated comparison under standard three-valued SQL logic, silently excluding those rows too
 * instead of including them. A plain positive `equals` match to find the (few) chat rows, then excluding their
 * ids, has no such edge case.
 */
async function chatConnectionIds(app: ZodFastifyInstance, guildId: string): Promise<string[]> {
  const rows = await app.prisma.integrationConnection.findMany({
    where: { guildId, config: { path: ['kind'], equals: 'chat' } },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * True for an alert-watch row — one created by `POST /:guildId/integrations/alerts`, which is the only place
 * that ever writes a `channelId` (the Discord channel the alert posts to) into `config`. A generic
 * OAuth/webhook connection's `config` is `{}` and a chat-kind one's is `{ kind: 'chat' }` (see
 * `isChatKindConnection`), so neither ever collides with this check.
 *
 * Deliberately evaluated in JS over rows already fetched, rather than as a Prisma JSON-path `where` filter.
 * `chatConnectionIds` above can afford a JSON filter because it is a *positive equality* match on a known
 * value (`kind === 'chat'`), whose Postgres semantics are unambiguous. A *presence* check has no such
 * safe form: `not: Prisma.DbNull` on a `path` filter hinges on whether Prisma emits "the extracted path is
 * NULL" or "the config column is NULL", and those differ catastrophically here — the latter matches every
 * row, which would exclude every connection and render the dashboard's Providers grid permanently empty.
 * That distinction is not observable in this repo's tests (`apps/api/test` runs against an in-memory Prisma
 * stub, not Postgres), so a filter relying on it would be unverifiable in CI. Partitioning in JS is provably
 * correct, needs no Postgres-specific semantics, and costs one query instead of three — these lists are
 * per-guild and small.
 */
function isAlertWatchConnection(config: unknown): boolean {
  return Boolean(
    config && typeof config === 'object' && typeof (config as Record<string, unknown>).channelId === 'string',
  );
}

/**
 * Every genuine OAuth/webhook-established connection in `guildId`, newest first — i.e. all non-deleted rows
 * minus chat-kind rows (`isChatKindConnection`) and alert watches (`isAlertWatchConnection`).
 *
 * This is what makes `GET /:guildId/integrations` and `.../integrations/live` match their documented
 * contract: `useConnections` in `apps/web/src/lib/dashboard/integrations-queries.ts` describes them as
 * listing OAuth/webhook connections "distinct from the per-target alert watches", which
 * `GET .../integrations/alerts` lists on its own. Before this filter existed they returned alert watches
 * too — invisible while the dashboard rendered only the first row per provider, but user-facing once it
 * started rendering all of them (a Twitch watch showed up as a bogus "connected account" carrying a
 * Disconnect button that hit the generic disconnect route, which leaves `deletedAt` unset and so stranded
 * the watch in the Alerts tab). Deliberately not applied to the alerts route itself, which lists exactly
 * the rows this drops.
 */
async function genericConnections(app: ZodFastifyInstance, guildId: string) {
  const rows = await app.prisma.integrationConnection.findMany({
    where: { guildId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  return rows.filter((row) => !isChatKindConnection(row.config) && !isAlertWatchConnection(row.config));
}

const alertCreateSchema = z.object({
  provider: z.enum(ALERT_PROVIDER_IDS as [AlertProviderId, ...AlertProviderId[]]),
  target: z.string().trim().min(1).max(200),
  channelId: snowflakeSchema,
  roleId: snowflakeSchema.nullable().optional(),
  template: z.string().max(300).nullable().optional(),
});
const alertsListQuerySchema = z.object({
  provider: z.enum(ALERT_PROVIDER_IDS as [AlertProviderId, ...AlertProviderId[]]).optional(),
});

const outboundCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().url(),
  events: z.array(z.enum(OUTBOUND_PLATFORM_EVENTS)).min(1),
});

const deliveriesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** `/guilds/:guildId/integrations` — connection list/connect/disconnect/status, and inbound webhook endpoint CRUD (ARCHITECTURE.md §10). */
export default async function integrationsRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/integrations',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<IntegrationConnectionDetailDto[]> => {
      const guildId = request.guildId!;
      const rows = await genericConnections(app, guildId);
      return rows.map(toIntegrationConnectionDetailDto);
    },
  );

  // -------------------------------------------------------------------------------------------------------
  // "Live now" indicator (multi-account-integrations spec §C) — Twitch only. Every other provider (including
  // YouTube — see lib/integrations/live-status.ts's file comment) has no live/offline concept at all, so it
  // always reports `live: null` rather than a fabricated on/off state (CLAUDE.md "No fake content"). On-demand
  // only — nothing here runs as a background poll, so an idle dashboard costs zero Twitch quota.
  // -------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/integrations/live',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<IntegrationLiveStatusDto[]> => {
      const guildId = request.guildId!;
      const rows = await genericConnections(app, guildId);

      // Resolve a Twitch login per row from `externalAccountName`, which the OAuth callback stores as the
      // broadcaster's login (not display name — see routes/oauth-integrations.ts) precisely so this lookup
      // and Helix's `user_login` agree. `rows` holds only generic connections, so there is no alert-watch
      // `config.target` to fall back to here. A connection linked before that callback started recording the
      // login has no name at all — it stays unresolved and reports `live: null` rather than guessing.
      const loginByConnectionId = new Map<string, string>();
      for (const row of rows) {
        if (row.provider !== 'TWITCH' || !row.externalAccountName) continue;
        loginByConnectionId.set(row.id, row.externalAccountName.toLowerCase());
      }

      const liveByLogin = await fetchTwitchLiveStatuses(twitchLiveStatusContextFrom(app), [
        ...loginByConnectionId.values(),
      ]);

      return rows.map((row) => {
        const login = loginByConnectionId.get(row.id);
        const status = login ? (liveByLogin.get(login) ?? null) : null;
        return {
          connectionId: row.id,
          live: status ? status.live : null,
          title: status?.live ? status.title : null,
          startedAt: status?.live ? status.startedAt : null,
        };
      });
    },
  );

  app.post(
    '/:guildId/integrations/:provider/connect',
    { schema: { params: providerParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { provider } = request.params as { provider: IntegrationProviderId };

      if (isOAuthProvider(provider)) {
        if (!isOAuthProviderConfigured(provider)) {
          throw new ExternalServiceError(`${provider} is not configured on this server.`);
        }
        const state = randomBytes(24).toString('hex');
        await app.redis.set(
          redisKey('oauthstate', 'integration', state),
          JSON.stringify({ guildId, provider, userId: session.userId }),
          'EX',
          600,
        );
        const redirectUri = `${env.API_BASE_URL ?? ''}/integrations/${provider}/callback`;
        return { url: buildProviderAuthorizeUrl(provider, state, redirectUri) };
      }

      if (isWebhookProvider(provider)) {
        const connection = await app.prisma.integrationConnection.create({
          data: {
            guildId,
            provider: PROVIDER_ENUM_MAP[provider],
            status: 'CONNECTED',
            config: {},
            connectedBy: session.userId,
          },
        });

        // `generic_webhook` is the only webhook-kind provider left (github/stripe were removed as connectable
        // providers 2026-09-02) — always a fresh per-guild secret + endpoint, unlike Stripe's old single shared
        // globally-verified endpoint.
        const secret = randomBytes(32).toString('hex');
        const endpointRow = await app.prisma.webhookEndpoint.create({
          data: {
            guildId,
            direction: 'INBOUND',
            provider,
            name: `${provider} webhook`,
            secretEnc: encryptSecret(secret),
            events: [],
          },
        });
        const endpointDto: WebhookEndpointDto = toWebhookEndpointDto(endpointRow);
        const webhookUrl = `${env.API_BASE_URL ?? ''}${webhookPathFor(endpointRow.id)}`;

        await writeDashboardAudit(app.prisma, {
          guildId,
          actorId: session.userId,
          action: AuditAction.IntegrationConnect,
          targetType: 'integration_connection',
          targetId: connection.id,
          after: { provider },
        });

        // `secret` is returned exactly once here — it is never retrievable again (only the encrypted form is stored).
        return {
          connection: toIntegrationConnectionDto(connection),
          endpoint: endpointDto,
          webhookUrl,
          secret,
        };
      }

      throw new ValidationError('Unknown integration provider.');
    },
  );

  app.post(
    '/:guildId/integrations/:connectionId/disconnect',
    { schema: { params: connectionParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { connectionId } = request.params as { connectionId: string };
      const existing = await app.prisma.integrationConnection.findFirst({
        where: { id: connectionId, guildId, deletedAt: null },
      });
      // A chat-kind connection isn't a generic connection at all — it belongs to `routes/twitch-chat.ts`'s
      // channel DELETE, which also retires the connection. Treat it as not-found here rather than letting a
      // generic disconnect tear its token out from under the still-linked `TwitchChatChannel`.
      if (!existing || isChatKindConnection(existing.config)) {
        throw new NotFoundError('Integration connection not found.');
      }

      await app.prisma.integrationConnection.update({
        where: { id: connectionId },
        data: { status: 'DISCONNECTED' },
      });
      await app.prisma.oAuthToken.deleteMany({ where: { connectionId } });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.IntegrationDisconnect,
        targetType: 'integration_connection',
        targetId: connectionId,
      });

      return { ok: true };
    },
  );

  app.get(
    '/:guildId/integrations/:connectionId/status',
    { schema: { params: connectionParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const { connectionId } = request.params as { connectionId: string };
      const row = await app.prisma.integrationConnection.findFirst({ where: { id: connectionId, guildId } });
      if (!row) throw new NotFoundError('Integration connection not found.');
      return toIntegrationConnectionDetailDto(row);
    },
  );

  // Inbound endpoints only — outbound endpoints have their own `/integrations/outbound` list below, so the
  // dashboard's Webhooks tab can show "inbound" and "outbound" as separate, non-overlapping lists.
  app.get(
    '/:guildId/integrations/webhooks',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<WebhookEndpointDetailDto[]> => {
      const rows = await app.prisma.webhookEndpoint.findMany({
        where: { guildId: request.guildId!, direction: 'INBOUND', deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toWebhookEndpointDetailDto);
    },
  );

  app.post(
    '/:guildId/integrations/webhooks',
    { schema: { params: guildIdParamSchema, body: webhookCreateSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const secret = randomBytes(32).toString('hex');
      const row = await app.prisma.webhookEndpoint.create({
        data: {
          guildId,
          direction: 'INBOUND',
          provider: request.body.provider,
          name: request.body.name,
          events: request.body.events,
          channelId: request.body.channelId,
          secretEnc: encryptSecret(secret),
        },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.IntegrationWebhookCreate,
        targetType: 'webhook_endpoint',
        targetId: row.id,
        after: { name: row.name, provider: row.provider },
      });

      reply.status(201);
      return {
        ...toWebhookEndpointDto(row),
        secret,
        url: `${env.API_BASE_URL ?? ''}/webhooks/generic/${row.id}`,
      };
    },
  );

  app.delete(
    '/:guildId/integrations/webhooks/:endpointId',
    { schema: { params: endpointParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { endpointId } = request.params as { endpointId: string };
      const existing = await app.prisma.webhookEndpoint.findFirst({
        where: { id: endpointId, guildId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Webhook endpoint not found.');

      await app.prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: { deletedAt: new Date(), enabled: false },
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.IntegrationWebhookDelete,
        targetType: 'webhook_endpoint',
        targetId: endpointId,
      });
      reply.status(204);
      return null;
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Provider availability (dashboard setup hints)
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/integrations/providers',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (): Promise<IntegrationProviderInfoDto[]> => {
      return listProviderAvailability();
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Alert watches (Twitch/YouTube/Reddit/Steam) — one `IntegrationConnection` row per watched target.
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/integrations/alerts',
    {
      schema: { params: guildIdParamSchema, querystring: alertsListQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<IntegrationConnectionDetailDto[]> => {
      const guildId = request.guildId!;
      const { provider } = request.query;
      const excludeIds = await chatConnectionIds(app, guildId);
      const where = {
        guildId,
        deletedAt: null,
        provider: provider
          ? CANONICAL_PROVIDER_ENUM_MAP[provider]
          : { in: ALERT_PROVIDER_IDS.map((id) => CANONICAL_PROVIDER_ENUM_MAP[id]) },
        ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
      };
      const rows = await app.prisma.integrationConnection.findMany({ where, orderBy: { createdAt: 'desc' } });
      return rows.map(toIntegrationConnectionDetailDto);
    },
  );

  app.post(
    '/:guildId/integrations/alerts',
    { schema: { params: guildIdParamSchema, body: alertCreateSchema }, preHandler: requireGuildAccess() },
    async (request, reply): Promise<IntegrationConnectionDetailDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { provider, target, channelId, roleId, template } = request.body;

      const missingEnv = listProviderAvailability().find((p) => p.id === provider)?.missingEnv ?? [];
      const config = { target, channelId, roleId: roleId ?? null, template: template ?? null };

      const connection = await app.prisma.integrationConnection.create({
        data: {
          guildId,
          provider: CANONICAL_PROVIDER_ENUM_MAP[provider],
          label: target,
          status: missingEnv.length === 0 ? 'CONNECTED' : 'ERROR',
          config,
          connectedBy: session.userId,
          lastError:
            missingEnv.length > 0 ? `Missing environment variable(s): ${missingEnv.join(', ')}.` : null,
        },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.IntegrationConnect,
        targetType: 'integration_connection',
        targetId: connection.id,
        after: { provider, target, channelId },
      });

      reply.status(201);
      return toIntegrationConnectionDetailDto(connection);
    },
  );

  app.delete(
    '/:guildId/integrations/alerts/:connectionId',
    { schema: { params: connectionParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { connectionId } = request.params as { connectionId: string };
      const existing = await app.prisma.integrationConnection.findFirst({
        where: { id: connectionId, guildId, deletedAt: null },
      });
      // A chat-kind connection was never an alert watch (see `isChatKindConnection`) — refuse to touch it here.
      if (!existing || isChatKindConnection(existing.config)) {
        throw new NotFoundError('Alert connection not found.');
      }

      await app.prisma.integrationConnection.update({
        where: { id: connectionId },
        data: { status: 'DISCONNECTED', deletedAt: new Date() },
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.IntegrationDisconnect,
        targetType: 'integration_connection',
        targetId: connectionId,
      });

      reply.status(204);
      return null;
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Outbound webhooks
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/integrations/outbound',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<WebhookEndpointDetailDto[]> => {
      const rows = await app.prisma.webhookEndpoint.findMany({
        where: { guildId: request.guildId!, direction: 'OUTBOUND', deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toWebhookEndpointDetailDto);
    },
  );

  app.post(
    '/:guildId/integrations/outbound',
    { schema: { params: guildIdParamSchema, body: outboundCreateSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { name, url, events } = request.body;

      try {
        await assertPublicHttpUrl(url); // validated at creation AND again before every send (apps/bot's delivery.ts)
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : 'That URL was rejected.');
      }

      const secret = randomBytes(32).toString('hex');
      const endpoint = await app.prisma.webhookEndpoint.create({
        data: {
          guildId,
          direction: 'OUTBOUND',
          provider: 'generic',
          name,
          url,
          events,
          secretEnc: encryptSecret(secret),
        },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.IntegrationWebhookCreate,
        targetType: 'webhook_endpoint',
        targetId: endpoint.id,
        after: { name, events, direction: 'outbound' },
      });

      reply.status(201);
      return { ...toWebhookEndpointDetailDto(endpoint), secret };
    },
  );

  app.delete(
    '/:guildId/integrations/outbound/:endpointId',
    { schema: { params: endpointParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { endpointId } = request.params as { endpointId: string };
      const existing = await app.prisma.webhookEndpoint.findFirst({
        where: { id: endpointId, guildId, direction: 'OUTBOUND', deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Outbound webhook not found.');

      await app.prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: { deletedAt: new Date(), enabled: false },
      });
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: AuditAction.IntegrationWebhookDelete,
        targetType: 'webhook_endpoint',
        targetId: endpointId,
      });

      reply.status(204);
      return null;
    },
  );

  app.post(
    '/:guildId/integrations/outbound/:endpointId/test',
    { schema: { params: endpointParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { endpointId } = request.params as { endpointId: string };
      const existing = await app.prisma.webhookEndpoint.findFirst({
        where: { id: endpointId, guildId, direction: 'OUTBOUND', deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Outbound webhook not found.');

      await app.queues.botActions().add('integrations.testWebhook', {
        type: 'integrations.testWebhook',
        guildId,
        payload: { endpointId },
        requestedBy: session.userId,
      });

      return { queued: true };
    },
  );

  app.get(
    '/:guildId/integrations/outbound/:endpointId/deliveries',
    {
      schema: { params: endpointParamSchema, querystring: deliveriesQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<{ items: WebhookDeliveryDto[]; nextCursor: string | null }> => {
      const guildId = request.guildId!;
      const { endpointId } = request.params as { endpointId: string };
      const { cursor, limit = 25 } = request.query;

      const endpoint = await app.prisma.webhookEndpoint.findFirst({
        where: { id: endpointId, guildId, direction: 'OUTBOUND' },
      });
      if (!endpoint) throw new NotFoundError('Outbound webhook not found.');

      const rows = await app.prisma.webhookDelivery.findMany({
        where: { endpointId },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      return {
        items: items.map(toWebhookDeliveryDto),
        nextCursor: hasMore ? items[items.length - 1]!.id : null,
      };
    },
  );
}
