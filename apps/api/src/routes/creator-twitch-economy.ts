import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { AppError, NotFoundError } from '@pavisie/core';
import type { ChannelEconomy } from '@pavisie/database';
import type {
  CreatorChannelEconomyDto,
  CreatorChannelEconomySettingsDto,
  CreatorEconomyAdjustResultDto,
  CreatorEconomyLeaderboardDto,
} from '@pavisie/types/creator';
import {
  adminAdjustChannel,
  getChannelBalanceLeaderboard,
  getChannelEarnedLeaderboard,
} from '@pavisie/plugins/channel-economy/ledger';
import {
  CHANNEL_ECONOMY_DEFAULTS,
  findChannelEconomySettingsProblem,
  pickChannelEconomySettings,
  updateChannelEconomySettingsSchema,
} from '@pavisie/plugins/channel-economy/settings';
import { requireTwitchCreator } from '../lib/creator/auth';
import { TWITCH_LOGIN_PATTERN, lookupTwitchUserByLogin, normalizeTwitchLogin } from '../lib/creator/twitch-users';

const CREATOR_ROUTE_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
/** Manual balance changes are deliberate, one-at-a-time actions — a tighter budget than reads. */
const ADJUST_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

const LEADERBOARD_DEFAULT_LIMIT = 10;
const MAX_ADJUST_AMOUNT = 1_000_000_000;

const leaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(LEADERBOARD_DEFAULT_LIMIT),
});

const adjustSchema = z
  .object({
    login: z
      .string()
      .transform(normalizeTwitchLogin)
      .refine((login) => TWITCH_LOGIN_PATTERN.test(login), { message: 'That is not a valid Twitch username.' }),
    direction: z.enum(['add', 'remove']),
    amount: z.number().int().min(1).max(MAX_ADJUST_AMOUNT),
    reason: z.string().trim().min(1, 'A reason is required.').max(200),
  })
  .strict();

function toSettingsDto(row: ChannelEconomy | null): CreatorChannelEconomySettingsDto {
  return row ? pickChannelEconomySettings(row) : { ...CHANNEL_ECONOMY_DEFAULTS };
}

function toEconomyDto(row: ChannelEconomy | null): CreatorChannelEconomyDto {
  return { configured: row !== null, settings: toSettingsDto(row) };
}

/**
 * `/creator/twitch/economy/*` — the signed-in streamer's OWN channel currency (`ChannelEconomy`, ARCHITECTURE.md
 * §18b/§19e): configure it, see the top viewers, and manually adjust a viewer's balance.
 *
 * Ownership is by construction: the economy is always looked up as (TWITCH, the session's own Twitch user id), so no
 * other channel's currency is reachable from any URL or body, and there is no id to guess (nothing to 403 vs 404).
 * The row is created by the streamer's FIRST SAVE (PATCH), never by viewing (GET returns the defaults with
 * `configured: false` and writes nothing). It works with no Discord server and no chat-bot connection at all.
 * Every mutating route needs the creator session's CSRF token (`lib/csrf.ts`). No audit-log rows: the audit log is
 * per Discord guild and a creator action has no Discord actor; a balance adjustment is recorded on the ledger
 * itself (`admin_add` / `admin_remove` with the reason as its note).
 */
export default async function creatorTwitchEconomyRoutes(app: ZodFastifyInstance): Promise<void> {
  async function findOwnEconomy(creatorUserId: string): Promise<ChannelEconomy | null> {
    return app.prisma.channelEconomy.findUnique({
      where: { platform_channelUserId: { platform: 'TWITCH', channelUserId: creatorUserId } },
    });
  }

  app.get(
    '/',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorChannelEconomyDto> => {
      return toEconomyDto(await findOwnEconomy(request.creator!.platformUserId));
    },
  );

  app.patch(
    '/',
    { ...CREATOR_ROUTE_RATE_LIMIT, schema: { body: updateChannelEconomySettingsSchema }, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorChannelEconomyDto> => {
      const creatorUserId = request.creator!.platformUserId;
      const body = request.body;
      const existing = await findOwnEconomy(creatorUserId);

      // An empty patch changes nothing — and in particular must not create the row.
      if (Object.keys(body).length === 0) return toEconomyDto(existing);

      const merged = { ...toSettingsDto(existing), ...body };
      const problem = findChannelEconomySettingsProblem(merged);
      if (problem) {
        throw new AppError('invalid_economy_settings', problem, { status: 400, expose: true });
      }

      // Native upsert on the (platform, channelUserId) unique key: the first save creates the row from the
      // defaults + this patch, every later save updates only what was sent — and two racing first saves cannot
      // both insert.
      const row = await app.prisma.channelEconomy.upsert({
        where: { platform_channelUserId: { platform: 'TWITCH', channelUserId: creatorUserId } },
        create: { platform: 'TWITCH', channelUserId: creatorUserId, ...merged },
        update: body,
      });
      return toEconomyDto(row);
    },
  );

  app.get(
    '/leaderboard',
    { ...CREATOR_ROUTE_RATE_LIMIT, schema: { querystring: leaderboardQuerySchema }, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorEconomyLeaderboardDto> => {
      const { limit } = request.query as z.infer<typeof leaderboardQuerySchema>;
      const economy = await findOwnEconomy(request.creator!.platformUserId);
      if (!economy) return { configured: false, earned: [], balance: [] };

      const [earned, balance] = await Promise.all([
        getChannelEarnedLeaderboard(app.prisma, economy.id, limit),
        getChannelBalanceLeaderboard(app.prisma, economy.id, limit),
      ]);
      return {
        configured: true,
        earned: earned.map((row) => ({
          viewerUserId: row.viewerUserId,
          displayName: row.displayName,
          earned: row.earned.toString(),
        })),
        balance: balance.map((row) => ({
          viewerUserId: row.viewerUserId,
          displayName: row.displayName,
          balance: row.balance.toString(),
        })),
      };
    },
  );

  // The streamer's manual add/remove on one viewer's balance. The login is resolved to a stable Twitch user id via
  // Helix (the wallet key) after being checked against Twitch's own login alphabet; a reason is mandatory and is
  // stored on the ledger row. A remove can never take a balance below zero.
  app.post(
    '/adjust',
    { ...ADJUST_RATE_LIMIT, schema: { body: adjustSchema }, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorEconomyAdjustResultDto> => {
      const body = request.body;
      const economy = await findOwnEconomy(request.creator!.platformUserId);
      if (!economy) throw new NotFoundError('Set up your channel currency first.');

      const lookup = await lookupTwitchUserByLogin(app, body.login);
      if (!lookup.ok) {
        throw new AppError('twitch_lookup_failed', "Couldn't reach Twitch to look that viewer up. Try again in a moment.", {
          status: 502,
          expose: true,
        });
      }
      if (!lookup.user) {
        throw new AppError('twitch_user_not_found', "Couldn't find that Twitch user.", { status: 404, expose: true });
      }

      const result = await adminAdjustChannel(
        app.prisma,
        { economyId: economy.id, viewerUserId: lookup.user.id },
        body.direction === 'add' ? 1 : -1,
        body.amount,
        body.reason,
        lookup.user.displayName,
      );
      if (!result.ok) {
        if (result.reason === 'would_go_negative') {
          throw new AppError('would_go_negative', "That would take the viewer's balance below zero.", {
            status: 409,
            expose: true,
          });
        }
        throw new AppError('invalid_amount', 'Enter a whole number of at least 1.', { status: 400, expose: true });
      }

      return {
        viewer: { userId: lookup.user.id, login: lookup.user.login, displayName: lookup.user.displayName },
        direction: body.direction,
        amount: String(body.amount),
        newBalance: result.newBalance.toString(),
      };
    },
  );
}
