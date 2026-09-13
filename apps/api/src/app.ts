import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import {
  ConfigError,
  createLogger,
  createPlatformEvents,
  createRedis,
  env,
  isProduction,
  redisKey,
  toPublicError,
} from '@pavisie/core';
import { prisma as sharedPrisma, type PrismaClient } from '@pavisie/database';
import { createGuildConfigStore } from './lib/config-store';
import { csrfProtection } from './lib/csrf';
import { describeFastifyClientError, isFastifyRateLimitError } from './lib/fastify-errors';
import type { ZodFastifyInstance } from './lib/http';
import { dispatchOverlayMessage } from './lib/overlay-registry';
import { QueueRegistry, type QueueRegistryLike } from './lib/queues';
import { getSession, SESSION_COOKIE_NAME } from './lib/session';

import authRoutes from './routes/auth';
import guildsRoutes from './routes/guilds';
import pluginsRoutes from './routes/plugins';
import auditRoutes from './routes/audit';
import moderationRoutes from './routes/moderation';
import automodRoutes from './routes/automod';
import loggingRoutes from './routes/logging';
import ticketsRoutes from './routes/tickets';
import rolesRoutes from './routes/roles';
import engagementRoutes from './routes/engagement';
import communityRoutes from './routes/community';
import integrationsRoutes from './routes/integrations';
import twitchChatRoutes from './routes/twitch-chat';
import oauthIntegrationsRoutes from './routes/oauth-integrations';
import aiRoutes from './routes/ai';
import analyticsRoutes from './routes/analytics';
import privacyRoutes from './routes/privacy';
import discordRoutes from './routes/discord';
import webhooksRoutes from './routes/webhooks';
import enforcerRoutes from './routes/enforcer';
import donationsRoutes from './routes/donations';
import verifyRoutes from './routes/verify';
import overlayRoutes from './routes/overlay';
import developerReportsRoutes from './routes/developer-reports';
import ownerMetricsRoutes from './routes/owner-metrics';
import twitchBotRoutes from './routes/twitch-bot';

export interface BuildAppDeps {
  prisma?: PrismaClient;
  redis?: Redis;
  queues?: QueueRegistryLike;
  /** Defaults to `createLogger('api')`. Tests inject a silent logger to avoid pino-pretty's worker-thread transport startup cost. */
  logger?: Logger;
  /**
   * Dedicated ioredis client the OBS-overlay `/overlay/*` routes subscribe on (channel-points spec v1,
   * "Overlay transport"). Defaults to a real `createRedis(env.REDIS_URL)` connection — tests MUST inject a
   * fake here (an `ioredis-mock` instance, same as `redis`) or every test that calls `buildApp()` opens a
   * real TCP connection attempt to Redis. See the long comment where this is consumed below for why it must
   * be a second client rather than reusing `redis`.
   */
  overlaySubscriber?: Redis;
}

/**
 * Builds (but does not start listening on) the Fastify API app. Accepts injected `prisma`/`redis`/`queues`
 * so tests can pass a fake Prisma client and `ioredis-mock` instead of touching real infrastructure
 * (ARCHITECTURE.md §10).
 */
/**
 * Cross-site cookies (`SESSION_COOKIE_SAMESITE=none`) require the session cookie to be `Secure`, which browsers
 * only honor over https — so refuse to start rather than silently issue a cookie the browser will drop
 * (ARCHITECTURE.md §21). A bare hostname (no scheme, e.g. local testing shorthand) is treated as non-https.
 */
function assertSameSiteNoneIsServeable(): void {
  if (env.SESSION_COOKIE_SAMESITE !== 'none') return;
  if (!env.API_BASE_URL || !env.API_BASE_URL.startsWith('https://')) {
    throw new ConfigError(
      'SESSION_COOKIE_SAMESITE=none requires API_BASE_URL to be an https:// URL (cross-site cookies must be Secure). ' +
        `Got API_BASE_URL=${env.API_BASE_URL ?? '(unset)'}.`,
    );
  }
}

export async function buildApp(deps: BuildAppDeps = {}): Promise<ZodFastifyInstance> {
  assertSameSiteNoneIsServeable();

  const prisma = deps.prisma ?? sharedPrisma;
  const redis = deps.redis ?? createRedis(env.REDIS_URL ?? 'redis://localhost:6379');
  const queues = deps.queues ?? new QueueRegistry(redis);

  // Second, dedicated ioredis client for the channel-point-rewards OBS overlay's bot -> API push
  // (channel-points spec v1, "Overlay transport"; bot -> API push doesn't exist anywhere else in this repo
  // today — the 3 BullMQ queues above all flow API -> bot). Once a client issues (P)SUBSCRIBE it enters
  // Redis's subscriber mode and can no longer run ordinary commands on that connection — so this MUST be
  // separate from `redis` above, which BullMQ, the rate limiter, and the session store all issue plain
  // GET/SET/INCR commands on continuously. This design is correct with N API replicas: pub/sub has no
  // consumer-group semantics, so every replica's subscriber receives every published message, but each
  // replica only writes into its own local `overlay-registry` connection map (lib/overlay-registry.ts) —
  // exactly the replica holding a given viewer's long-lived SSE connection is the only one that needs to see
  // that viewer's message, and that's exactly what happens here.
  const overlaySubscriber = deps.overlaySubscriber ?? createRedis(env.REDIS_URL ?? 'redis://localhost:6379');
  const overlayChannelPrefix = `${redisKey('overlay')}:`;
  await overlaySubscriber.psubscribe(`${overlayChannelPrefix}*`);
  overlaySubscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
    if (!channel.startsWith(overlayChannelPrefix)) return;
    const channelId = channel.slice(overlayChannelPrefix.length);
    if (channelId) dispatchOverlayMessage(channelId, message);
  });

  const app = Fastify({
    loggerInstance: deps.logger ?? createLogger('api'),
    genReqId: () => randomUUID(),
    trustProxy: env.TRUST_PROXY,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // `TRUST_PROXY=true` (bare boolean, as opposed to a hop-count number) trusts the *leftmost* `X-Forwarded-For`
  // entry, which the client fully controls — this is exactly what let the 2026-08-26 card-testing abuse defeat
  // the per-IP rate limit below by rotating a spoofed header value (see the doc comment on `trustProxyFromString`
  // in packages/core/src/env.ts). Warn loudly rather than refusing to boot, since misconfiguration here is
  // recoverable without downtime.
  if (env.NODE_ENV === 'production' && env.TRUST_PROXY === true) {
    app.log.warn(
      'TRUST_PROXY=true trusts the leftmost X-Forwarded-For value, which callers control — request.ip is ' +
        'attacker-controlled and per-IP rate limiting is not effective. Set TRUST_PROXY to the number of proxies ' +
        'actually in front of this service instead (e.g. TRUST_PROXY=1 behind Railway).',
    );
  }

  const events = createPlatformEvents();
  const { store: configStore, registry } = createGuildConfigStore(prisma, redis, events);

  app.decorate('prisma', prisma);
  app.decorate('redis', redis);
  app.decorate('queues', queues);
  app.decorate('configStore', configStore);
  app.decorate('registry', registry);
  app.decorateRequest('session', null);

  await app.register(helmet, {
    // This process only ever serves JSON, plus (outside production — see the swagger/swaggerUi registration
    // below) the swagger UI at /docs.
    contentSecurityPolicy: false,
  });

  const corsAllowlist = [env.DASHBOARD_URL, env.WEB_URL].filter((url): url is string => Boolean(url));
  await app.register(cors, {
    origin: corsAllowlist.length > 0 ? corsAllowlist : false,
    credentials: true,
  });

  await app.register(cookie, {
    secret: env.SESSION_SECRET,
    hook: 'onRequest',
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Redis-backed (installed version: @fastify/rate-limit@10.3.0, confirmed via node_modules) so counters are
    // shared across API instances and survive restarts/deploys — the previous unset `store` option used an
    // in-process `LocalStore`, which resets on every deploy and isn't shared with sibling instances. That gap is
    // exactly what let the 2026-08-26 card-testing abuse continue across deploys. The plugin's option for this is
    // `redis` (an ioredis instance directly, not a `store` constructor) — see its README and
    // `store/RedisStore.js`, which calls `redis.defineCommand('rateLimit', { numberOfKeys: 1, lua })` once per
    // instance and then invokes that command per request. Verified against `ioredis-mock` (what `deps.redis` is
    // in tests, per `test/helpers/build-test-app.ts`): it implements `defineCommand`/Lua scripting well enough to
    // run this script (only INCR/PEXPIRE/PTTL) correctly, so no in-memory fallback is needed for `NODE_ENV=test`.
    redis,
    // per-route overrides (auth routes: 20/min) are set via each route's `config.rateLimit`.
  });


  await app.register(sensible);

  // Publicly documenting the exact request/response shape of every endpoint (including public, unauthenticated
  // ones) is a gift to anyone probing for abuse — keep `/docs` out of production entirely (404, via the default
  // not-found handler) rather than trying to lock it behind auth. Still available in development and test.
  if (env.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: {
        info: { title: 'Pavisie API', version: '0.1.0' },
        servers: [{ url: env.API_BASE_URL ?? 'http://localhost:3001' }],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  // Resolves the session for every request (used by requireAuth/requireGuildAccess/csrfProtection downstream).
  app.addHook('onRequest', async (request) => {
    const raw = request.cookies[SESSION_COOKIE_NAME];
    if (!raw) {
      request.session = null;
      return;
    }
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) {
      request.session = null;
      return;
    }
    request.session = await getSession(redis, unsigned.value);
  });

  app.addHook('preHandler', csrfProtection);

  // Fastify snapshots each route's error/not-found handler into its compiled context at `register()` time,
  // per Fastify's plugin encapsulation model — so these MUST be set before any route plugin (`app.register(authRoutes, ...)`
  // etc, below) is registered, or those routes keep using Fastify's built-in defaults regardless of what's
  // set here afterwards.
  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .send({ error: { code: 'not_found', message: `Route ${request.method} ${request.url} not found.` } });
  });

  app.setErrorHandler((err, request, reply) => {
    // fastify-type-provider-zod's validatorCompiler doesn't throw a raw ZodError (which `toPublicError`
    // knows how to shape) — Fastify wraps its per-issue output into a standard `FST_ERR_VALIDATION` error
    // with an `err.validation` array instead. Normalize that into the same `validation_error` 400 shape.
    const validation = (
      err as {
        validation?: {
          message: string;
          instancePath: string;
          params?: { issue?: { path?: (string | number)[] } };
        }[];
      }
    ).validation;
    if (Array.isArray(validation)) {
      const body = {
        error: {
          code: 'validation_error',
          message: 'Validation failed.',
          details: {
            issues: validation.map((v) => ({
              path: v.params?.issue?.path?.join('.') ?? v.instancePath.replace(/^\//, '').replace(/\//g, '.'),
              message: v.message,
            })),
          },
        },
      };
      request.log.info({ code: body.error.code }, 'Request validation error');
      reply.status(400).send(body);
      return;
    }

    // Fastify's own client errors (content-type parser: empty/invalid JSON body, unsupported media type, body
    // too large, ...) are plain `FastifyError`s carrying a proper 4xx `statusCode`. Keep that status and map
    // the code to a fixed public message instead of letting `toPublicError` report them as a 500.
    const fastifyErr = err as { code?: unknown; statusCode?: unknown };
    if (
      typeof fastifyErr.code === 'string' &&
      fastifyErr.code.startsWith('FST_ERR_') &&
      typeof fastifyErr.statusCode === 'number' &&
      fastifyErr.statusCode >= 400 &&
      fastifyErr.statusCode < 500
    ) {
      const { code, message } = describeFastifyClientError(fastifyErr.code, fastifyErr.statusCode);
      request.log.info({ code }, 'Request error');
      reply.status(fastifyErr.statusCode).send({ error: { code, message } });
      return;
    }

    // `@fastify/rate-limit` throws a plain Error with `statusCode: 429` (no `code`) — same treatment.
    if (isFastifyRateLimitError(fastifyErr)) {
      request.log.info({ code: 'rate_limited' }, 'Request error');
      reply.status(429).send({ error: { code: 'rate_limited', message: 'Rate limit exceeded.' } });
      return;
    }

    const { status, body } = toPublicError(err);
    if (status >= 500) {
      request.log.error({ err }, 'Unhandled API error');
    } else {
      request.log.info({ code: body.error.code }, 'Request error');
    }
    reply.status(status).send(body);
  });

  app.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
    const checks = { db: false, redis: false };
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.db = true;
    } catch {
      checks.db = false;
    }
    try {
      checks.redis = (await redis.ping()) === 'PONG';
    } catch {
      checks.redis = false;
    }
    const healthy = checks.db && checks.redis;
    reply.status(healthy ? 200 : 503);
    return { status: healthy ? 'ok' : 'degraded', checks };
  });

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(guildsRoutes, { prefix: '/guilds' });
  await app.register(pluginsRoutes, { prefix: '/guilds' });
  await app.register(auditRoutes, { prefix: '/guilds' });
  await app.register(moderationRoutes, { prefix: '/guilds' });
  await app.register(automodRoutes, { prefix: '/guilds' });
  await app.register(loggingRoutes, { prefix: '/guilds' });
  await app.register(ticketsRoutes, { prefix: '/guilds' });
  await app.register(rolesRoutes, { prefix: '/guilds' });
  await app.register(engagementRoutes, { prefix: '/guilds' });
  await app.register(communityRoutes, { prefix: '/guilds' });
  await app.register(integrationsRoutes, { prefix: '/guilds' });
  await app.register(twitchChatRoutes, { prefix: '/guilds' });
  await app.register(aiRoutes, { prefix: '/guilds' });
  await app.register(analyticsRoutes, { prefix: '/guilds' });
  await app.register(privacyRoutes, { prefix: '/guilds' });
  await app.register(discordRoutes, { prefix: '/guilds' });
  await app.register(enforcerRoutes, { prefix: '/guilds' });
  await app.register(oauthIntegrationsRoutes, { prefix: '/integrations' });
  await app.register(donationsRoutes, { prefix: '/donations' });
  await app.register(webhooksRoutes, { prefix: '/webhooks', bodyLimit: 5 * 1024 * 1024 });
  await app.register(verifyRoutes, { prefix: '/verify' });
  await app.register(overlayRoutes, { prefix: '/overlay' });
  await app.register(developerReportsRoutes, { prefix: '/owner' });
  await app.register(ownerMetricsRoutes, { prefix: '/owner' });
  await app.register(twitchBotRoutes, { prefix: '/owner' });

  app.addHook('onClose', async () => {
    if (!deps.queues) {
      await (queues as QueueRegistry).closeAll?.();
    }
  });

  app.addHook('onClose', async () => {
    if (deps.overlaySubscriber) return; // caller-owned (tests) — they close it themselves.
    try {
      // Explicit PUNSUBSCRIBE before QUIT: harmless on real Redis, and required for `ioredis-mock` (used by
      // every test that builds this app) whose `disconnect()`/`quit()` don't actually detach the pattern
      // listener they registered — only `punsubscribe()` does — so skipping this leaks one listener on a
      // shared, cross-instance EventEmitter per test and eventually trips Node's MaxListenersExceededWarning.
      await overlaySubscriber.punsubscribe();
      await overlaySubscriber.quit();
    } catch {
      overlaySubscriber.disconnect();
    }
  });

  return app;
}

export { isProduction };
