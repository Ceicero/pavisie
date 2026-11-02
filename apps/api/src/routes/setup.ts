import { randomUUID } from 'node:crypto';
import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import type { StreamerStarterQueuedDto, StreamerStarterResultDto } from '@pavisie/types';
import { streamerStarterResultKey } from '@pavisie/plugins/admin/starter-pack';
import { normalizeTwitchLogin } from '@pavisie/plugins/integrations/providers/twitch';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema, snowflakeSchema } from '../lib/schemas';

const requestIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const resultParamSchema = guildIdParamSchema.extend({ requestId: requestIdSchema });

const streamerStarterBodySchema = z
  .object({
    twitchLogin: z.string().trim().max(100).nullish(),
    alertChannelId: snowflakeSchema.nullish(),
  })
  .superRefine((body, ctx) => {
    const login = body.twitchLogin?.trim();
    if (!login) return;
    if (!normalizeTwitchLogin(login)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['twitchLogin'],
        message:
          'That is not a valid Twitch username (letters, numbers and underscores, up to 25 characters).',
      });
    }
    if (!body.alertChannelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['alertChannelId'],
        message: 'Pick the channel go-live alerts should be posted in.',
      });
    }
  });

/**
 * `/guilds/:guildId/setup/*` — the dashboard side of the streamer starter pack (the `/setup streamer` command).
 *
 * The API cannot create Discord channels or validate a Twitch login with the bot's own plumbing, and the preset's
 * whole point is that the command and the button run the same code, so this route does not apply anything itself:
 * it queues an `admin.streamerStarter` bot action and the bot runs `applyStreamerStarter`, audit-logs it (actor =
 * the signed-in Discord user, source `dashboard`) and leaves the report in Redis, which the `GET` below reads back.
 */
export default async function setupRoutes(app: ZodFastifyInstance): Promise<void> {
  app.post(
    '/:guildId/setup/streamer-starter',
    {
      schema: { params: guildIdParamSchema, body: streamerStarterBodySchema },
      preHandler: requireGuildAccess(),
    },
    async (request, reply): Promise<StreamerStarterQueuedDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const requestId = randomUUID();
      const login = request.body.twitchLogin?.trim();

      await app.queues.botActions().add('bot-action', {
        type: 'admin.streamerStarter',
        guildId,
        payload: {
          requestId,
          twitchLogin: login ? login : null,
          alertChannelId: login ? (request.body.alertChannelId ?? null) : null,
        },
        requestedBy: session.userId,
      });

      reply.status(202);
      return { requestId };
    },
  );

  app.get(
    '/:guildId/setup/streamer-starter/:requestId',
    { schema: { params: resultParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<StreamerStarterResultDto> => {
      const { requestId } = request.params as { requestId: string };
      const raw = await app.redis.get(streamerStarterResultKey(request.guildId!, requestId));
      if (raw === null) return { status: 'pending' };
      return JSON.parse(raw) as StreamerStarterResultDto;
    },
  );
}
