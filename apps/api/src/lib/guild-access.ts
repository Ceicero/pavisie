import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, NotFoundError, PermissionError } from '@pavisie/core';
import { decryptAccessToken } from './session';
import { getCachedUserGuilds, hasManageAccess } from './discord';

/** 401 — no (or an expired) session; distinct from `PermissionError` (403), which means "you have a session but can't do this". */
export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required.') {
    super('unauthenticated', message, { status: 401, expose: true });
    this.name = 'UnauthenticatedError';
  }
}

/** Throws `UnauthenticatedError` (401) unless a live session is present. */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.session) {
    throw new UnauthenticatedError();
  }
}

export interface RequireGuildAccessOptions {
  /** When true, skip the "bot must be present" 404 check (used by routes that help onboard a guild the bot hasn't joined yet). */
  allowBotAbsent?: boolean;
}

/**
 * Verifies the session user has MANAGE_GUILD/ADMINISTRATOR/owner on `request.params.guildId` (from their
 * cached Discord guild list) and — unless `allowBotAbsent` — that the bot is present in that guild.
 * Decorates `request.guildId` on success (ARCHITECTURE.md §10).
 */
export function requireGuildAccess(options: RequireGuildAccessOptions = {}) {
  return async function guildAccessPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuth(request, reply);
    const session = request.session!;

    const { guildId } = request.params as { guildId?: string };
    if (!guildId) {
      throw new NotFoundError('Missing guild id.');
    }

    const accessToken = decryptAccessToken(session);
    const guilds = await getCachedUserGuilds(request.server.redis, session.userId, accessToken);
    const match = guilds.find((g) => g.id === guildId);

    if (!match || !hasManageAccess(match.permissions, match.owner)) {
      throw new PermissionError('You do not have permission to manage this server.');
    }

    if (!options.allowBotAbsent) {
      const guild = await request.server.prisma.guild.findUnique({ where: { id: guildId } });
      if (!guild || !guild.botPresent) {
        throw new NotFoundError('Pavisie is not in this server.');
      }
    }

    request.guildId = guildId;
  };
}
