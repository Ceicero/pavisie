import type { FastifyReply, FastifyRequest } from 'fastify';
import { NotFoundError } from '@pavisie/core';
import { UnauthenticatedError } from '../guild-access';

/** Throws `UnauthenticatedError` (401) unless a live creator session is present (`request.creator`, set by the
 * creator-session `onRequest` hook in `app.ts`). The Discord `sid` session is deliberately irrelevant here. */
export async function requireCreatorAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.creator) {
    throw new UnauthenticatedError();
  }
}

/** For the Twitch-specific creator routes: requires a creator session AND that it is a Twitch one (a Kick creator
 * would hit their own route tree). Non-Twitch sessions get a 404, same as "not your channel". */
export async function requireTwitchCreator(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireCreatorAuth(request, reply);
  if (request.creator!.platform !== 'twitch') {
    throw new NotFoundError('Not found.');
  }
}
