import type { FastifyReply, FastifyRequest } from 'fastify';
import { PermissionError, listFromCsv } from '@pavisie/core';
import { requireAuth } from './guild-access';

export interface RequireBotOwnerOptions {
  /**
   * Overrides the allowlist (tests only — see `test/bot-owner.test.ts`). When omitted, every request re-reads
   * `process.env.BOT_OWNER_IDS` directly, deliberately bypassing `@pavisie/core`'s cached `env` singleton
   * (which is parsed once, from whatever `process.env` held at first import, and never re-reads it). A live
   * re-read means the allowlist can be rotated by an operator without a redeploy, and a test can flip it
   * per-case with a plain `process.env.BOT_OWNER_IDS = '...'` assignment instead of resetting the module cache.
   */
  ownerIds?: string[];
}

/**
 * Bot-owner-only preHandler for cross-guild ops endpoints (the developer-reports inbox today; any future
 * cross-guild ops tooling). Deliberately separate from `requireGuildAccess` — bot-owner identity has nothing to
 * do with which guilds a Discord user happens to manage. Fails CLOSED: an empty/unset allowlist denies every
 * request, never allows every request. Requires a live dashboard session first (401 via `requireAuth`), then
 * checks the session's Discord user id against the allowlist (403 otherwise).
 */
export function requireBotOwner(options: RequireBotOwnerOptions = {}) {
  return async function requireBotOwnerPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuth(request, reply);

    const ownerIds = options.ownerIds ?? listFromCsv(process.env.BOT_OWNER_IDS);
    if (ownerIds.length === 0 || !ownerIds.includes(request.session!.userId)) {
      throw new PermissionError('This endpoint is restricted to the bot owner.');
    }
  };
}
