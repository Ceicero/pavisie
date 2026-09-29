import type { ZodFastifyInstance } from '../lib/http';
import type { CreatorMeDto } from '@pavisie/types/creator';
import { requireCreatorAuth } from '../lib/creator/auth';
import { toCreatorIdentityDto } from '../lib/creator/dto';
import { startTwitchCreatorLogin } from '../lib/creator/oauth';
import { clearCreatorSessionCookie, currentCreatorSid, destroyCreatorSession } from '../lib/creator/session';

const AUTH_ROUTE_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
const ME_ROUTE_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

/**
 * `/creator/*` — sign-in and session routes for the creator dashboard (ARCHITECTURE.md §19e). URL shapes carry the
 * platform (`/creator/auth/twitch/...`) so a second platform (Kick) slots in beside Twitch later. The sign-in
 * callback itself is NOT a route here: it reuses the already-registered Twitch redirect URI and is dispatched from
 * `routes/oauth-integrations.ts` (see `lib/creator/oauth.ts`).
 */
export default async function creatorAuthRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get('/auth/twitch/login', AUTH_ROUTE_RATE_LIMIT, async (_request, reply) => {
    const url = await startTwitchCreatorLogin(app, reply);
    reply.redirect(url);
  });

  app.get('/me', { ...ME_ROUTE_RATE_LIMIT, preHandler: requireCreatorAuth }, async (request): Promise<CreatorMeDto> => {
    const session = request.creator!;
    return { creator: toCreatorIdentityDto(session), csrfToken: session.csrfToken };
  });

  // CSRF-protected like every mutating route (lib/csrf.ts checks the creator session's token for `/creator/*`).
  app.post('/logout', AUTH_ROUTE_RATE_LIMIT, async (request, reply) => {
    const sid = currentCreatorSid(request);
    if (sid) {
      await destroyCreatorSession(app.redis, sid);
    }
    clearCreatorSessionCookie(reply);
    return { ok: true };
  });
}
