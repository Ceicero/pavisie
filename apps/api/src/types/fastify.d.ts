import type Redis from 'ioredis';
import type { PrismaClient } from '@pavisie/database';
import type { GuildConfigStore, PluginRegistry } from '@pavisie/plugins/sdk';
import type { QueueRegistryLike } from '../lib/queues';
import type { SessionData } from '../lib/session';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis: Redis;
    queues: QueueRegistryLike;
    configStore: GuildConfigStore;
    registry: PluginRegistry;
  }

  interface FastifyRequest {
    /** The authenticated dashboard user's session, or `null` if unauthenticated. Set by the session `onRequest` hook. */
    session: SessionData | null;
    /** Set by `requireGuildAccess` once the actor's access to `params.guildId` has been verified. */
    guildId?: string;
  }
}
