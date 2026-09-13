import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import {
  AppError,
  NotFoundError,
  ValidationError,
  decryptSecret,
  env,
  verifyGithubSignature,
  verifyHmacSha256,
  verifyTwitchEventSubSignature,
} from '@pavisie/core';
import { Prisma } from '@pavisie/database';

const endpointParamSchema = z.object({ endpointId: z.string().min(1) });

function rawBodyOf(request: FastifyRequest): string {
  // The `application/json` content-type parser registered below yields the raw string, not a parsed object,
  // so signatures can be verified over the exact bytes the provider signed.
  return typeof request.body === 'string' ? request.body : '';
}

function safeJsonParse(raw: string): unknown {
  try {
    return raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    throw new ValidationError('Invalid JSON payload.');
  }
}

/**
 * Records `[provider, eventId]` as processed, returning `false` (do not process again) if it already was.
 * Relies on `ProcessedWebhookEvent`'s `@@unique([provider, eventId])` for the actual race-safe guarantee.
 */
async function claimEventOnce(app: ZodFastifyInstance, provider: string, eventId: string): Promise<boolean> {
  try {
    await app.prisma.processedWebhookEvent.create({ data: { provider, eventId } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return false;
    }
    throw err;
  }
}

function invalidSignature(): AppError {
  return new AppError('invalid_signature', 'Webhook signature verification failed.', {
    status: 401,
    expose: true,
  });
}

/**
 * `/webhooks/*` — inbound provider webhooks (NOT under `/guilds`, not session-authenticated). Every handler:
 * verifies a provider signature over the raw body, enforces idempotency via `ProcessedWebhookEvent`, then
 * enqueues `{ provider, endpointId?, eventType, payload }` onto the `integrations.inbound` queue
 * (ARCHITECTURE.md §10). 5MB body limit is set where this plugin is registered in `app.ts`.
 */
export default async function webhooksRoutes(app: ZodFastifyInstance): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  app.post('/github/:endpointId', { schema: { params: endpointParamSchema } }, async (request, reply) => {
    const { endpointId } = request.params as { endpointId: string };
    const raw = rawBodyOf(request);
    const signatureHeader = request.headers['x-hub-signature-256'];
    const deliveryId = request.headers['x-github-delivery'];
    const eventType = request.headers['x-github-event'];

    if (typeof signatureHeader !== 'string' || typeof deliveryId !== 'string') {
      throw new ValidationError('Missing GitHub webhook headers.');
    }

    const endpoint = await app.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, direction: 'INBOUND', enabled: true, deletedAt: null },
    });
    if (!endpoint) throw new NotFoundError('Unknown webhook endpoint.');

    const secret = decryptSecret(endpoint.secretEnc);
    if (!verifyGithubSignature(raw, secret, signatureHeader)) {
      await app.prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: { failureCount: { increment: 1 } },
      });
      throw invalidSignature();
    }

    const isNew = await claimEventOnce(app, 'github', deliveryId);
    if (isNew) {
      await app.queues.integrationsInbound().add('github', {
        provider: 'github',
        endpointId,
        guildId: endpoint.guildId,
        eventType: typeof eventType === 'string' ? eventType : 'unknown',
        payload: safeJsonParse(raw),
      });
      await app.prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: { lastDeliveryAt: new Date(), failureCount: 0 },
      });
    }

    reply.status(202);
    return { ok: true };
  });

  app.post('/twitch', async (request, reply) => {
    const raw = rawBodyOf(request);
    const messageId = request.headers['twitch-eventsub-message-id'];
    const timestamp = request.headers['twitch-eventsub-message-timestamp'];
    const signatureHeader = request.headers['twitch-eventsub-message-signature'];
    const messageType = request.headers['twitch-eventsub-message-type'];

    if (
      typeof messageId !== 'string' ||
      typeof timestamp !== 'string' ||
      typeof signatureHeader !== 'string'
    ) {
      throw new ValidationError('Missing Twitch EventSub headers.');
    }
    if (!env.TWITCH_EVENTSUB_SECRET) {
      throw new AppError('twitch_not_configured', 'Twitch EventSub is not configured on this server.', {
        status: 503,
        expose: true,
      });
    }

    const valid = verifyTwitchEventSubSignature({
      messageId,
      timestamp,
      body: raw,
      secret: env.TWITCH_EVENTSUB_SECRET,
      signatureHeader,
    });
    if (!valid) throw invalidSignature();

    const payload = safeJsonParse(raw) as {
      challenge?: string;
      subscription?: {
        id?: string;
        type?: string;
        status?: string;
        condition?: { broadcaster_user_id?: string };
      };
    };

    if (messageType === 'webhook_callback_verification') {
      reply.header('Content-Type', 'text/plain');
      return reply.status(200).send(payload.challenge ?? '');
    }

    if (messageType === 'revocation') {
      // Twitch revoked the subscription (broadcaster deauthorized, or Twitch gave up after too many delivery
      // failures) — mark every TWITCH connection that was using it as errored and drop the stale subscription id,
      // so the next `poll-twitch` job run (packages/plugins/src/integrations/jobs/poll.ts) recreates it.
      const subscriptionId = payload.subscription?.id;
      const reason = payload.subscription?.status ?? 'revoked';
      if (subscriptionId) {
        const candidates = await app.prisma.integrationConnection.findMany({
          where: { provider: 'TWITCH', deletedAt: null },
        });
        const matches = candidates.filter(
          (c) => (c.config as Record<string, unknown> | null)?.eventSubId === subscriptionId,
        );
        for (const connection of matches) {
          const { eventSubId: _drop, ...rest } = (connection.config as Record<string, unknown>) ?? {};
          await app.prisma.integrationConnection.update({
            where: { id: connection.id },
            data: {
              status: 'ERROR',
              lastError: `Twitch EventSub subscription revoked (${reason}).`,
              config: rest as Prisma.InputJsonValue,
            },
          });
        }
      }
      reply.status(202);
      return { ok: true };
    }

    const isNew = await claimEventOnce(app, 'twitch', messageId);
    if (isNew) {
      await app.queues.integrationsInbound().add('twitch', {
        provider: 'twitch',
        eventType: payload.subscription?.type ?? 'unknown',
        payload,
      });
    }

    reply.status(202);
    return { ok: true };
  });

  app.post('/generic/:endpointId', { schema: { params: endpointParamSchema } }, async (request, reply) => {
    const { endpointId } = request.params as { endpointId: string };
    const raw = rawBodyOf(request);
    const signatureHeader = request.headers['x-pavisie-signature'];
    const eventIdHeader = request.headers['x-pavisie-event-id'];
    const eventTypeHeader = request.headers['x-pavisie-event-type'];

    if (typeof signatureHeader !== 'string') {
      throw new ValidationError('Missing X-Pavisie-Signature header.');
    }

    const endpoint = await app.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, direction: 'INBOUND', enabled: true, deletedAt: null },
    });
    if (!endpoint) throw new NotFoundError('Unknown webhook endpoint.');

    const secret = decryptSecret(endpoint.secretEnc);
    if (!verifyHmacSha256(raw, secret, signatureHeader)) {
      await app.prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: { failureCount: { increment: 1 } },
      });
      throw invalidSignature();
    }

    const eventId =
      typeof eventIdHeader === 'string' && eventIdHeader.length > 0
        ? eventIdHeader
        : createHash('sha256').update(raw).digest('hex');
    const isNew = await claimEventOnce(app, `generic:${endpointId}`, eventId);
    if (isNew) {
      await app.queues.integrationsInbound().add('generic', {
        provider: 'generic',
        endpointId,
        guildId: endpoint.guildId,
        eventType: typeof eventTypeHeader === 'string' ? eventTypeHeader : 'unknown',
        payload: safeJsonParse(raw),
      });
      await app.prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: { lastDeliveryAt: new Date(), failureCount: 0 },
      });
    }

    reply.status(202);
    return { ok: true };
  });
}
