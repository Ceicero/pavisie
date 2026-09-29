import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import { AppError, NotFoundError } from '@pavisie/core';
import type { TwitchChatCommandDto, TwitchChatTimerDto } from '@pavisie/types/integrations';
import type { CreatorTwitchChannelDto, CreatorTwitchChannelStatusDto } from '@pavisie/types/creator';
import { requireTwitchCreator } from '../lib/creator/auth';
import { toCreatorTwitchChannelDto } from '../lib/creator/dto';
import { startTwitchCreatorConnect } from '../lib/creator/oauth';
import { toTwitchChatCommandDto, toTwitchChatTimerDto } from '../lib/integrations/dto';
import { isOAuthProviderConfigured } from '../lib/integrations/providers';
import { nudgeTwitchChatReconcile } from '../lib/integrations/twitch-chat-reconcile';
import {
  TWITCH_CHAT_MAX_COMMANDS_PER_CHANNEL,
  TWITCH_CHAT_MAX_TIMERS_PER_CHANNEL,
  createTwitchChatCommandSchema,
  createTwitchChatTimerSchema,
  updateTwitchChatChannelSchema,
  updateTwitchChatCommandSchema,
  updateTwitchChatTimerSchema,
} from '../lib/integrations/twitch-chat-schemas';
import {
  TWITCH_CHAT_LEVEL_ENUM_MAP,
  commandExistsError,
  isUniqueViolation,
  timerExistsError,
} from '../lib/integrations/twitch-chat-shared';

const CREATOR_ROUTE_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

const commandParamSchema = z.object({ commandId: z.string().min(1) });
const timerParamSchema = z.object({ timerId: z.string().min(1) });

/** A creator can change only these two settings themselves. The Discord bridge and channel-point reward toggles
 * on the same row belong to the Discord dashboard (and later phases), so they are rejected here, not ignored. */
const updateCreatorChannelSchema = updateTwitchChatChannelSchema
  .pick({ enabled: true, commandPrefix: true })
  .strict();

/**
 * `/creator/twitch/*` — a signed-in Twitch creator managing THEIR OWN chat-bot channel (ARCHITECTURE.md §19e).
 *
 * Ownership rule: the creator whose Twitch user id equals `TwitchChatChannel.broadcasterUserId` owns that row,
 * whether or not it is also linked to a Discord server. The channel is therefore never addressed by an id in the
 * URL — it is always looked up from the session — so "someone else's channel" is unreachable by construction; an
 * absent channel (or a command/timer id that belongs to another channel) is a 404, never a 403, so a probe cannot
 * tell "exists but not yours" from "does not exist".
 *
 * Every route needs a creator session (401 otherwise); every mutating route also needs that session's CSRF token
 * (`lib/csrf.ts`). No audit-log rows are written: the audit log is per Discord guild and a creator action has no
 * Discord actor (a guildless channel has no guild at all).
 */
export default async function creatorTwitchRoutes(app: ZodFastifyInstance): Promise<void> {
  /** The signed-in creator's own channel row, or `null`. */
  async function findOwnChannel(creatorUserId: string) {
    return app.prisma.twitchChatChannel.findFirst({ where: { broadcasterUserId: creatorUserId } });
  }

  async function requireOwnChannel(creatorUserId: string) {
    const channel = await findOwnChannel(creatorUserId);
    if (!channel) throw new NotFoundError('Twitch chat channel not found.');
    return channel;
  }

  // -----------------------------------------------------------------------------------------------------------
  // Channel
  // -----------------------------------------------------------------------------------------------------------

  app.get(
    '/channel',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorTwitchChannelStatusDto> => {
      const creator = request.creator!;
      const [botIdentity, channel] = await Promise.all([
        app.prisma.twitchBotIdentity.findFirst(),
        findOwnChannel(creator.platformUserId),
      ]);
      return {
        botConfigured: Boolean(botIdentity),
        botLogin: botIdentity?.botLogin ?? null,
        envConfigured: isOAuthProviderConfigured('twitch'),
        channel: channel ? toCreatorTwitchChannelDto(channel) : null,
      };
    },
  );

  // Starts (or re-starts) connecting the bot to the creator's chat: the same broadcaster consent screen the
  // Discord flow uses, but the state is marked as a creator connect (no guild). Its callback
  // (`lib/creator/oauth.ts`, dispatched from `/integrations/twitch/callback`) refuses any Twitch account other
  // than the signed-in creator.
  app.post(
    '/channel/connect',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<{ url: string }> => {
      const url = await startTwitchCreatorConnect(app.redis, request.creator!);
      return { url };
    },
  );

  app.patch(
    '/channel',
    { ...CREATOR_ROUTE_RATE_LIMIT, schema: { body: updateCreatorChannelSchema }, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorTwitchChannelDto> => {
      const creator = request.creator!;
      const body = request.body;
      const existing = await requireOwnChannel(creator.platformUserId);

      const updated = await app.prisma.twitchChatChannel.update({
        where: { id: existing.id },
        data: {
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.commandPrefix !== undefined ? { commandPrefix: body.commandPrefix } : {}),
        },
      });

      nudgeTwitchChatReconcile(app, existing.guildId ?? '');
      return toCreatorTwitchChannelDto(updated);
    },
  );

  // Disconnect the bot from the creator's chat. Semantics differ on purpose by whether a Discord server is also
  // linked to this row:
  //  - guildless row: nothing else depends on it, so it is deleted (commands/timers/rewards cascade) — exactly
  //    what the Discord dashboard's own unlink does for a guild's channel.
  //  - guild-linked row: the Discord server still owns commands, timers, rewards, bridge settings and the
  //    economy link on this same row. Deleting it from here would silently wipe another surface's data, so the
  //    bot is only switched off (`enabled=false`, `status=DISCONNECTED`); the Discord side keeps everything and
  //    the creator can reconnect later.
  app.delete(
    '/channel',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request, reply) => {
      const creator = request.creator!;
      const existing = await requireOwnChannel(creator.platformUserId);

      if (existing.guildId) {
        await app.prisma.twitchChatChannel.update({
          where: { id: existing.id },
          data: { enabled: false, status: 'DISCONNECTED' },
        });
      } else {
        await app.prisma.twitchChatChannel.delete({ where: { id: existing.id } });
      }

      nudgeTwitchChatReconcile(app, existing.guildId ?? '');
      reply.status(204);
      return null;
    },
  );

  // -----------------------------------------------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------------------------------------------

  app.get(
    '/channel/commands',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<TwitchChatCommandDto[]> => {
      const channel = await requireOwnChannel(request.creator!.platformUserId);
      const rows = await app.prisma.twitchChatCommand.findMany({
        where: { channelId: channel.id },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toTwitchChatCommandDto);
    },
  );

  app.post(
    '/channel/commands',
    { ...CREATOR_ROUTE_RATE_LIMIT, schema: { body: createTwitchChatCommandSchema }, preHandler: requireTwitchCreator },
    async (request, reply): Promise<TwitchChatCommandDto> => {
      const creator = request.creator!;
      const body = request.body;
      const channel = await requireOwnChannel(creator.platformUserId);

      const clash = await app.prisma.twitchChatCommand.findUnique({
        where: { channelId_name: { channelId: channel.id, name: body.name } },
      });
      if (clash) throw commandExistsError(body.name);

      const count = await app.prisma.twitchChatCommand.count({ where: { channelId: channel.id } });
      if (count >= TWITCH_CHAT_MAX_COMMANDS_PER_CHANNEL) {
        throw new AppError(
          'twitch_chat_command_limit',
          `This channel has reached its limit of ${TWITCH_CHAT_MAX_COMMANDS_PER_CHANNEL} commands.`,
          { status: 400, expose: true },
        );
      }

      // Friendly fast path above; the DB's `@@unique([channelId, name])` is the real guard against a race.
      let row;
      try {
        row = await app.prisma.twitchChatCommand.create({
          data: {
            channelId: channel.id,
            // The row's own guild link, if any — so a command a creator adds to a Discord-linked channel is
            // visible to that server's dashboard too. Null for a guildless channel.
            guildId: channel.guildId,
            name: body.name,
            response: body.response,
            cooldownSeconds: body.cooldownSeconds ?? 5,
            minLevel: TWITCH_CHAT_LEVEL_ENUM_MAP[body.minLevel ?? 'everyone'],
            createdBy: creator.platformUserId,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw commandExistsError(body.name);
        throw err;
      }

      nudgeTwitchChatReconcile(app, channel.guildId ?? '');
      reply.status(201);
      return toTwitchChatCommandDto(row);
    },
  );

  app.patch(
    '/channel/commands/:commandId',
    {
      ...CREATOR_ROUTE_RATE_LIMIT,
      schema: { params: commandParamSchema, body: updateTwitchChatCommandSchema },
      preHandler: requireTwitchCreator,
    },
    async (request): Promise<TwitchChatCommandDto> => {
      const { commandId } = request.params as { commandId: string };
      const body = request.body;
      const channel = await requireOwnChannel(request.creator!.platformUserId);

      const existing = await app.prisma.twitchChatCommand.findFirst({
        where: { id: commandId, channelId: channel.id },
      });
      if (!existing) throw new NotFoundError('Twitch chat command not found.');

      if (body.name !== undefined && body.name !== existing.name) {
        const clash = await app.prisma.twitchChatCommand.findUnique({
          where: { channelId_name: { channelId: channel.id, name: body.name } },
        });
        if (clash && clash.id !== existing.id) throw commandExistsError(body.name);
      }

      let updated;
      try {
        updated = await app.prisma.twitchChatCommand.update({
          where: { id: commandId },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.response !== undefined ? { response: body.response } : {}),
            ...(body.cooldownSeconds !== undefined ? { cooldownSeconds: body.cooldownSeconds } : {}),
            ...(body.minLevel !== undefined ? { minLevel: TWITCH_CHAT_LEVEL_ENUM_MAP[body.minLevel] } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw commandExistsError(body.name ?? existing.name);
        throw err;
      }

      nudgeTwitchChatReconcile(app, channel.guildId ?? '');
      return toTwitchChatCommandDto(updated);
    },
  );

  app.delete(
    '/channel/commands/:commandId',
    { ...CREATOR_ROUTE_RATE_LIMIT, schema: { params: commandParamSchema }, preHandler: requireTwitchCreator },
    async (request, reply) => {
      const { commandId } = request.params as { commandId: string };
      const channel = await requireOwnChannel(request.creator!.platformUserId);

      const existing = await app.prisma.twitchChatCommand.findFirst({
        where: { id: commandId, channelId: channel.id },
      });
      if (!existing) throw new NotFoundError('Twitch chat command not found.');

      await app.prisma.twitchChatCommand.delete({ where: { id: commandId } });

      nudgeTwitchChatReconcile(app, channel.guildId ?? '');
      reply.status(204);
      return null;
    },
  );

  // -----------------------------------------------------------------------------------------------------------
  // Timers
  // -----------------------------------------------------------------------------------------------------------

  app.get(
    '/channel/timers',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<TwitchChatTimerDto[]> => {
      const channel = await requireOwnChannel(request.creator!.platformUserId);
      const rows = await app.prisma.twitchChatTimer.findMany({
        where: { channelId: channel.id },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toTwitchChatTimerDto);
    },
  );

  app.post(
    '/channel/timers',
    { ...CREATOR_ROUTE_RATE_LIMIT, schema: { body: createTwitchChatTimerSchema }, preHandler: requireTwitchCreator },
    async (request, reply): Promise<TwitchChatTimerDto> => {
      const creator = request.creator!;
      const body = request.body;
      const channel = await requireOwnChannel(creator.platformUserId);

      const clash = await app.prisma.twitchChatTimer.findUnique({
        where: { channelId_name: { channelId: channel.id, name: body.name } },
      });
      if (clash) throw timerExistsError(body.name);

      const count = await app.prisma.twitchChatTimer.count({ where: { channelId: channel.id } });
      if (count >= TWITCH_CHAT_MAX_TIMERS_PER_CHANNEL) {
        throw new AppError(
          'twitch_chat_timer_limit',
          `This channel has reached its limit of ${TWITCH_CHAT_MAX_TIMERS_PER_CHANNEL} timers.`,
          { status: 400, expose: true },
        );
      }

      let row;
      try {
        row = await app.prisma.twitchChatTimer.create({
          data: {
            channelId: channel.id,
            guildId: channel.guildId,
            name: body.name,
            message: body.message,
            intervalMinutes: body.intervalMinutes,
            createdBy: creator.platformUserId,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw timerExistsError(body.name);
        throw err;
      }

      nudgeTwitchChatReconcile(app, channel.guildId ?? '');
      reply.status(201);
      return toTwitchChatTimerDto(row);
    },
  );

  app.patch(
    '/channel/timers/:timerId',
    {
      ...CREATOR_ROUTE_RATE_LIMIT,
      schema: { params: timerParamSchema, body: updateTwitchChatTimerSchema },
      preHandler: requireTwitchCreator,
    },
    async (request): Promise<TwitchChatTimerDto> => {
      const { timerId } = request.params as { timerId: string };
      const body = request.body;
      const channel = await requireOwnChannel(request.creator!.platformUserId);

      const existing = await app.prisma.twitchChatTimer.findFirst({
        where: { id: timerId, channelId: channel.id },
      });
      if (!existing) throw new NotFoundError('Twitch chat timer not found.');

      if (body.name !== undefined && body.name !== existing.name) {
        const clash = await app.prisma.twitchChatTimer.findUnique({
          where: { channelId_name: { channelId: channel.id, name: body.name } },
        });
        if (clash && clash.id !== existing.id) throw timerExistsError(body.name);
      }

      let updated;
      try {
        updated = await app.prisma.twitchChatTimer.update({
          where: { id: timerId },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.message !== undefined ? { message: body.message } : {}),
            ...(body.intervalMinutes !== undefined ? { intervalMinutes: body.intervalMinutes } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw timerExistsError(body.name ?? existing.name);
        throw err;
      }

      nudgeTwitchChatReconcile(app, channel.guildId ?? '');
      return toTwitchChatTimerDto(updated);
    },
  );

  app.delete(
    '/channel/timers/:timerId',
    { ...CREATOR_ROUTE_RATE_LIMIT, schema: { params: timerParamSchema }, preHandler: requireTwitchCreator },
    async (request, reply) => {
      const { timerId } = request.params as { timerId: string };
      const channel = await requireOwnChannel(request.creator!.platformUserId);

      const existing = await app.prisma.twitchChatTimer.findFirst({
        where: { id: timerId, channelId: channel.id },
      });
      if (!existing) throw new NotFoundError('Twitch chat timer not found.');

      await app.prisma.twitchChatTimer.delete({ where: { id: timerId } });

      nudgeTwitchChatReconcile(app, channel.guildId ?? '');
      reply.status(204);
      return null;
    },
  );
}
