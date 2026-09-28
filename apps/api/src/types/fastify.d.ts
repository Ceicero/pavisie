import type Redis from 'ioredis';
import type { PrismaClient } from '@pavisie/database';
import type { GuildConfigStore, PluginRegistry } from '@pavisie/plugins/sdk';
import type { QueueRegistryLike } from '../lib/queues';
import type { SessionData } from '../lib/session';
import type { TwitchExtJwtPayload } from '../lib/twitch-ext/jwt';

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
    /** Set by `requireTwitchExtensionAuth` (`/twitch-ext/*` only) once the `Authorization: Bearer <JWT>` header
     * has been verified. Never set for any other route — this is a bearer-token identity, not a dashboard session. */
    twitchExt?: TwitchExtJwtPayload;
  }
}
