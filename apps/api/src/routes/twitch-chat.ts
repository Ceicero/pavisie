import { randomBytes } from 'node:crypto';
import type { ZodFastifyInstance } from '../lib/http';
import { z } from 'zod';
import {
  AppError,
  ExternalServiceError,
  NotFoundError,
  SsrfError,
  ValidationError,
  assertPublicHttpUrl,
  decryptSecret,
  encryptSecret,
  env,
  redisKey,
} from '@pavisie/core';
import {
  Prisma,
  type TwitchChatLevel as PrismaTwitchChatLevel,
  type TwitchRewardActionKind as PrismaTwitchRewardActionKind,
} from '@pavisie/database';
import type {
  TwitchChatChannelDto,
  TwitchChatCommandDto,
  TwitchChatLevelId,
  TwitchChatRewardDto,
  TwitchChatStatusDto,
  TwitchChatTimerDto,
  TwitchOverlayInfoDto,
  TwitchRewardActionKindId,
} from '@pavisie/types/integrations';
import { writeDashboardAudit } from '../lib/audit';
import { requireGuildAccess } from '../lib/guild-access';
import {
  TWITCH_REWARD_ACTION_MAP,
  toTwitchChatChannelDto,
  toTwitchChatCommandDto,
  toTwitchChatRewardDto,
  toTwitchChatTimerDto,
} from '../lib/integrations/dto';
import { buildProviderAuthorizeUrl, isOAuthProviderConfigured } from '../lib/integrations/providers';
import { nudgeTwitchChatReconcile } from '../lib/integrations/twitch-chat-reconcile';
import {
  TWITCH_CHAT_MAX_COMMANDS_PER_CHANNEL,
  TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL,
  TWITCH_CHAT_MAX_TIMERS_PER_CHANNEL,
  createTwitchChatCommandSchema,
  createTwitchChatRewardSchema,
  createTwitchChatTimerSchema,
  updateTwitchChatChannelSchema,
  updateTwitchChatCommandSchema,
  updateTwitchChatRewardSchema,
  updateTwitchChatTimerSchema,
} from '../lib/integrations/twitch-chat-schemas';
import { guildIdParamSchema } from '../lib/schemas';

/** Scopes requested when an admin links (or re-links) a broadcaster's Twitch channel.
 * `channel:bot` — the bot may read/send in that channel's chat.
 * `channel:read:redemptions` — required by the `channel.channel_points_custom_reward_redemption.add`
 * EventSub subscription, which only the BROADCASTER's own token may create. Kept as one constant so the
 * link and re-link paths can never drift apart and silently strand channel points. */
const TWITCH_CONNECT_SCOPES = 'channel:bot channel:read:redemptions';

const channelParamSchema = guildIdParamSchema.extend({ channelId: z.string().min(1) });
const commandParamSchema = guildIdParamSchema.extend({ commandId: z.string().min(1) });
const timerParamSchema = guildIdParamSchema.extend({ timerId: z.string().min(1) });
const rewardParamSchema = guildIdParamSchema.extend({ rewardId: z.string().min(1) });

/** `updateTwitchChatChannelSchema` (twitch-chat-schemas.ts, owned by Stage 1) predates the rewards toggle —
 * extended locally here rather than editing that shared schema file, since a plain `z.object` supports
 * `.extend()` and this route is the only caller that needs the extra field. */
const updateChannelWithRewardsSchema = updateTwitchChatChannelSchema.extend({
  rewardsEnabled: z.boolean().optional(),
});

/** Reverse of `TWITCH_REWARD_ACTION_MAP` (lib/integrations/dto.ts) — input action id -> Prisma enum, for writes. */
const TWITCH_REWARD_ACTION_ENUM_MAP: Record<TwitchRewardActionKindId, PrismaTwitchRewardActionKind> = {
  sound: 'SOUND',
  tts: 'TTS',
  chat: 'CHAT',
  discord: 'DISCORD',
};

/** Mirrors `twitch-chat-schemas.ts`'s private `TWITCH_REWARD_ACTION_FIELD_SPEC` (not exported — that file's
 * `superRefine` only ever sees one request body in isolation). On PATCH we additionally need to validate the
 * reward's *resulting* state (existing row merged with the patch), which only the route layer can do, so the
 * same small spec is duplicated here rather than exported purely for this one caller. */
const REWARD_ACTION_FIELDS = [
  'soundUrl',
  'volume',
  'ttsTemplate',
  'chatTemplate',
  'discordChannelId',
  'discordTemplate',
] as const;
type RewardActionField = (typeof REWARD_ACTION_FIELDS)[number];
const REWARD_ACTION_FIELD_SPEC: Record<
  TwitchRewardActionKindId,
  { required: readonly RewardActionField[]; allowed: readonly RewardActionField[] }
> = {
  sound: { required: ['soundUrl'], allowed: ['soundUrl', 'volume'] },
  tts: { required: ['ttsTemplate'], allowed: ['ttsTemplate'] },
  chat: { required: ['chatTemplate'], allowed: ['chatTemplate'] },
  discord: { required: ['discordChannelId', 'discordTemplate'], allowed: ['discordChannelId', 'discordTemplate'] },
};

/** Reverse of `TWITCH_CHAT_LEVEL_MAP` (lib/integrations/dto.ts) — input level id -> Prisma enum, for writes. */
const TWITCH_CHAT_LEVEL_ENUM_MAP: Record<TwitchChatLevelId, PrismaTwitchChatLevel> = {
  everyone: 'EVERYONE',
  subscriber: 'SUBSCRIBER',
  vip: 'VIP',
  moderator: 'MODERATOR',
  broadcaster: 'BROADCASTER',
};

/** True for Prisma's unique-constraint-violation error (P2002) — same check as `community.ts`'s `isUniqueViolation`. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function commandExistsError(name: string): AppError {
  return new AppError(
    'twitch_chat_command_exists',
    `A command named "${name}" already exists for this channel.`,
    { status: 409, expose: true },
  );
}

function timerExistsError(name: string): AppError {
  return new AppError(
    'twitch_chat_timer_exists',
    `A timer named "${name}" already exists for this channel.`,
    { status: 409, expose: true },
  );
}

function rewardExistsError(title: string): AppError {
  return new AppError(
    'twitch_chat_reward_exists',
    `A reward for "${title}" with that action already exists for this channel.`,
    { status: 409, expose: true },
  );
}

/** Converts an `SsrfError` from `assertPublicHttpUrl` into the same 400 shape as `routes/ai.ts`'s baseUrl check. */
async function assertSafeSoundUrl(url: string): Promise<void> {
  try {
    await assertPublicHttpUrl(url);
  } catch (err) {
    throw new ValidationError(err instanceof SsrfError ? err.message : 'That sound URL is not allowed.');
  }
}

/**
 * `/guilds/:guildId/integrations/twitch-chat` — Pavisie joining a streamer's Twitch chat (ARCHITECTURE.md
 * §J/§19). Lives inside the `integrations` plugin rather than as its own plugin. All chat reads/sends run on
 * the global `TwitchBotIdentity` token (owner-only, see `routes/twitch-bot.ts`) — this file only manages the
 * per-guild channel link, its custom commands, and its timers. No chat message content is ever stored here.
 */
export default async function twitchChatRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/integrations/twitch-chat',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<TwitchChatStatusDto> => {
      const guildId = request.guildId!;
      const [botIdentity, channels] = await Promise.all([
        app.prisma.twitchBotIdentity.findFirst(),
        app.prisma.twitchChatChannel.findMany({ where: { guildId }, orderBy: { createdAt: 'desc' } }),
      ]);

      return {
        botConfigured: Boolean(botIdentity),
        botLogin: botIdentity?.botLogin ?? null,
        envConfigured: isOAuthProviderConfigured('twitch'),
        channels: channels.map(toTwitchChatChannelDto),
      };
    },
  );

  app.post(
    '/:guildId/integrations/twitch-chat/connect',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<{ url: string }> => {
      const guildId = request.guildId!;
      const session = request.session!;

      if (!isOAuthProviderConfigured('twitch')) {
        throw new ExternalServiceError('Twitch is not configured on this server.');
      }

      const state = randomBytes(24).toString('hex');
      await app.redis.set(
        redisKey('oauthstate', 'integration', state),
        JSON.stringify({ guildId, provider: 'twitch', userId: session.userId, kind: 'twitch_chat' }),
        'EX',
        600,
      );

      const redirectUri = `${env.API_BASE_URL ?? ''}/integrations/twitch/callback`;
      // Both scopes are requested up front, on every link and re-link. `channel:bot` lets the bot act in chat;
      // `channel:read:redemptions` is what the channel-point EventSub subscription needs, and ONLY the
      // broadcaster's own token can carry it (the bot identity's token cannot create that subscription).
      // Requesting just `channel:bot` here made channel points unreachable in production: the reconcile loop
      // correctly reported "re-link required", but re-linking asked Twitch for the same narrow scope again, so
      // the grant could never appear no matter how many times an admin went through the flow.
      return { url: buildProviderAuthorizeUrl('twitch', state, redirectUri, TWITCH_CONNECT_SCOPES) };
    },
  );

  app.patch(
    '/:guildId/integrations/twitch-chat/channels/:channelId',
    {
      schema: { params: channelParamSchema, body: updateChannelWithRewardsSchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<TwitchChatChannelDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { channelId } = request.params as { channelId: string };
      const body = request.body;

      const existing = await app.prisma.twitchChatChannel.findFirst({ where: { id: channelId, guildId } });
      if (!existing) throw new NotFoundError('Twitch chat channel not found.');

      const updated = await app.prisma.twitchChatChannel.update({
        where: { id: channelId },
        data: {
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.commandPrefix !== undefined ? { commandPrefix: body.commandPrefix } : {}),
          ...(body.rewardsEnabled !== undefined ? { rewardsEnabled: body.rewardsEnabled } : {}),
        },
      });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'integration.twitch_chat.channel.update',
        targetType: 'twitch_chat_channel',
        targetId: channelId,
        before: {
          enabled: existing.enabled,
          commandPrefix: existing.commandPrefix,
          rewardsEnabled: existing.rewardsEnabled,
        },
        after: {
          enabled: updated.enabled,
          commandPrefix: updated.commandPrefix,
          rewardsEnabled: updated.rewardsEnabled,
        },
      });

      nudgeTwitchChatReconcile(app, guildId);

      return toTwitchChatChannelDto(updated);
    },
  );

  app.delete(
    '/:guildId/integrations/twitch-chat/channels/:channelId',
    { schema: { params: channelParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { channelId } = request.params as { channelId: string };

      const existing = await app.prisma.twitchChatChannel.findFirst({ where: { id: channelId, guildId } });
      if (!existing) throw new NotFoundError('Twitch chat channel not found.');

      // Mirrors `routes/integrations.ts`'s plain disconnect flow (POST `/:connectionId/disconnect`): mark the
      // linked connection disconnected and drop its tokens, rather than soft-deleting the connection outright.
      if (existing.connectionId) {
        await app.prisma.integrationConnection.update({
          where: { id: existing.connectionId },
          data: { status: 'DISCONNECTED' },
        });
        await app.prisma.oAuthToken.deleteMany({ where: { connectionId: existing.connectionId } });
      }

      // Cascades TwitchChatCommand/TwitchChatTimer rows (schema: onDelete: Cascade).
      await app.prisma.twitchChatChannel.delete({ where: { id: channelId } });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'integration.twitch_chat.channel.delete',
        targetType: 'twitch_chat_channel',
        targetId: channelId,
        before: { broadcasterLogin: existing.broadcasterLogin },
      });

      nudgeTwitchChatReconcile(app, guildId);

      reply.status(204);
      return null;
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/integrations/twitch-chat/channels/:channelId/commands',
    { schema: { params: channelParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<TwitchChatCommandDto[]> => {
      const guildId = request.guildId!;
      const { channelId } = request.params as { channelId: string };

      const channel = await app.prisma.twitchChatChannel.findFirst({ where: { id: channelId, guildId } });
      if (!channel) throw new NotFoundError('Twitch chat channel not found.');

      const rows = await app.prisma.twitchChatCommand.findMany({
        where: { channelId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toTwitchChatCommandDto);
    },
  );

  app.post(
    '/:guildId/integrations/twitch-chat/channels/:channelId/commands',
    {
      schema: { params: channelParamSchema, body: createTwitchChatCommandSchema },
      preHandler: requireGuildAccess(),
    },
    async (request, reply): Promise<TwitchChatCommandDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { channelId } = request.params as { channelId: string };
      const body = request.body;

      const channel = await app.prisma.twitchChatChannel.findFirst({ where: { id: channelId, guildId } });
      if (!channel) throw new NotFoundError('Twitch chat channel not found.');

      const clash = await app.prisma.twitchChatCommand.findUnique({
        where: { channelId_name: { channelId, name: body.name } },
      });
      if (clash) throw commandExistsError(body.name);

      const count = await app.prisma.twitchChatCommand.count({ where: { channelId } });
      if (count >= TWITCH_CHAT_MAX_COMMANDS_PER_CHANNEL) {
        throw new AppError(
          'twitch_chat_command_limit',
          `This channel has reached its limit of ${TWITCH_CHAT_MAX_COMMANDS_PER_CHANNEL} commands.`,
          { status: 400, expose: true },
        );
      }

      // The checks above are a friendly fast path, not the real guarantee — the DB's unique constraint
      // (`@@unique([channelId, name])`) is the actual guard against a concurrent create for the same name
      // (precedent: `routes/community.ts`'s tag create).
      let row;
      try {
        row = await app.prisma.twitchChatCommand.create({
          data: {
            channelId,
            guildId,
            name: body.name,
            response: body.response,
            cooldownSeconds: body.cooldownSeconds ?? 5,
            minLevel: TWITCH_CHAT_LEVEL_ENUM_MAP[body.minLevel ?? 'everyone'],
            createdBy: session.userId,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw commandExistsError(body.name);
        throw err;
      }

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'integration.twitch_chat.command.create',
        targetType: 'twitch_chat_command',
        targetId: row.id,
        after: { channelId, name: row.name },
      });

      nudgeTwitchChatReconcile(app, guildId);

      reply.status(201);
      return toTwitchChatCommandDto(row);
    },
  );

  app.patch(
    '/:guildId/integrations/twitch-chat/commands/:commandId',
    {
      schema: { params: commandParamSchema, body: updateTwitchChatCommandSchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<TwitchChatCommandDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { commandId } = request.params as { commandId: string };
      const body = request.body;

      const existing = await app.prisma.twitchChatCommand.findFirst({ where: { id: commandId, guildId } });
      if (!existing) throw new NotFoundError('Twitch chat command not found.');

      if (body.name !== undefined && body.name !== existing.name) {
        const clash = await app.prisma.twitchChatCommand.findUnique({
          where: { channelId_name: { channelId: existing.channelId, name: body.name } },
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

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'integration.twitch_chat.command.update',
        targetType: 'twitch_chat_command',
        targetId: commandId,
        before: {
          name: existing.name,
          response: existing.response,
          cooldownSeconds: existing.cooldownSeconds,
          minLevel: existing.minLevel,
          enabled: existing.enabled,
        },
        after: {
          name: updated.name,
          response: updated.response,
          cooldownSeconds: updated.cooldownSeconds,
          minLevel: updated.minLevel,
          enabled: updated.enabled,
        },
      });

      nudgeTwitchChatReconcile(app, guildId);

      return toTwitchChatCommandDto(updated);
    },
  );

  app.delete(
    '/:guildId/integrations/twitch-chat/commands/:commandId',
    { schema: { params: commandParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { commandId } = request.params as { commandId: string };

      const existing = await app.prisma.twitchChatCommand.findFirst({ where: { id: commandId, guildId } });
      if (!existing) throw new NotFoundError('Twitch chat command not found.');

      await app.prisma.twitchChatCommand.delete({ where: { id: commandId } });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'integration.twitch_chat.command.delete',
        targetType: 'twitch_chat_command',
        targetId: commandId,
        before: { name: existing.name },
      });

      nudgeTwitchChatReconcile(app, guildId);

      reply.status(204);
      return null;
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Timers
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/integrations/twitch-chat/channels/:channelId/timers',
    { schema: { params: channelParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<TwitchChatTimerDto[]> => {
      const guildId = request.guildId!;
      const { channelId } = request.params as { channelId: string };

      const channel = await app.prisma.twitchChatChannel.findFirst({ where: { id: channelId, guildId } });
      if (!channel) throw new NotFoundError('Twitch chat channel not found.');

      const rows = await app.prisma.twitchChatTimer.findMany({
        where: { channelId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toTwitchChatTimerDto);
    },
  );

  app.post(
    '/:guildId/integrations/twitch-chat/channels/:channelId/timers',
    {
      schema: { params: channelParamSchema, body: createTwitchChatTimerSchema },
      preHandler: requireGuildAccess(),
    },
    async (request, reply): Promise<TwitchChatTimerDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { channelId } = request.params as { channelId: string };
      const body = request.body;

      const channel = await app.prisma.twitchChatChannel.findFirst({ where: { id: channelId, guildId } });
      if (!channel) throw new NotFoundError('Twitch chat channel not found.');

      const clash = await app.prisma.twitchChatTimer.findUnique({
        where: { channelId_name: { channelId, name: body.name } },
      });
      if (clash) throw timerExistsError(body.name);

      const count = await app.prisma.twitchChatTimer.count({ where: { channelId } });
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
            channelId,
            guildId,
            name: body.name,
            message: body.message,
            intervalMinutes: body.intervalMinutes,
            createdBy: session.userId,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw timerExistsError(body.name);
        throw err;
      }

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'integration.twitch_chat.timer.create',
        targetType: 'twitch_chat_timer',
        targetId: row.id,
        after: { channelId, name: row.name },
      });

      nudgeTwitchChatReconcile(app, guildId);

      reply.status(201);
      return toTwitchChatTimerDto(row);
    },
  );

  app.patch(
    '/:guildId/integrations/twitch-chat/timers/:timerId',
    {
      schema: { params: timerParamSchema, body: updateTwitchChatTimerSchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<TwitchChatTimerDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { timerId } = request.params as { timerId: string };
      const body = request.body;

      const existing = await app.prisma.twitchChatTimer.findFirst({ where: { id: timerId, guildId } });
      if (!existing) throw new NotFoundError('Twitch chat timer not found.');

      if (body.name !== undefined && body.name !== existing.name) {
        const clash = await app.prisma.twitchChatTimer.findUnique({
          where: { channelId_name: { channelId: existing.channelId, name: body.name } },
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

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'integration.twitch_chat.timer.update',
        targetType: 'twitch_chat_timer',
        targetId: timerId,
        before: {
          name: existing.name,
          message: existing.message,
          intervalMinutes: existing.intervalMinutes,
          enabled: existing.enabled,
        },
        after: {
          name: updated.name,
          message: updated.message,
          intervalMinutes: updated.intervalMinutes,
          enabled: updated.enabled,
        },
      });

      nudgeTwitchChatReconcile(app, guildId);

      return toTwitchChatTimerDto(updated);
    },
  );

  app.delete(
    '/:guildId/integrations/twitch-chat/timers/:timerId',
    { schema: { params: timerParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { timerId } = request.params as { timerId: string };

      const existing = await app.prisma.twitchChatTimer.findFirst({ where: { id: timerId, guildId } });
      if (!existing) throw new NotFoundError('Twitch chat timer not found.');

      await app.prisma.twitchChatTimer.delete({ where: { id: timerId } });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'integration.twitch_chat.timer.delete',
        targetType: 'twitch_chat_timer',
        targetId: timerId,
        before: { name: existing.name },
      });

      nudgeTwitchChatReconcile(app, guildId);

      reply.status(204);
      return null;
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Channel-point rewards (channel-points spec v1) — a redeemed reward triggers a SOUND/TTS overlay event, a
  // TWITCH CHAT message, or a DISCORD post. Only the payload fields matching `action` are meaningful; the zod
  // schemas (twitch-chat-schemas.ts) enforce that shape for the request body in isolation, and this route
  // layer additionally enforces the SSRF guard on `soundUrl` and (on PATCH) the reward's *resulting* state.
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/integrations/twitch-chat/channels/:channelId/rewards',
    { schema: { params: channelParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<TwitchChatRewardDto[]> => {
      const guildId = request.guildId!;
      const { channelId } = request.params as { channelId: string };

      const channel = await app.prisma.twitchChatChannel.findFirst({ where: { id: channelId, guildId } });
      if (!channel) throw new NotFoundError('Twitch chat channel not found.');

      const rows = await app.prisma.twitchChatReward.findMany({
        where: { channelId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toTwitchChatRewardDto);
    },
  );

  app.post(
    '/:guildId/integrations/twitch-chat/channels/:channelId/rewards',
    {
      schema: { params: channelParamSchema, body: createTwitchChatRewardSchema },
      preHandler: requireGuildAccess(),
    },
    async (request, reply): Promise<TwitchChatRewardDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { channelId } = request.params as { channelId: string };
      const body = request.body;

      const channel = await app.prisma.twitchChatChannel.findFirst({ where: { id: channelId, guildId } });
      if (!channel) throw new NotFoundError('Twitch chat channel not found.');

      // The zod schema only checks URL shape (https, well-formed) — a live DNS lookup to catch
      // private/internal/metadata targets can only happen here at the route layer.
      if (body.soundUrl) await assertSafeSoundUrl(body.soundUrl);

      const action = TWITCH_REWARD_ACTION_ENUM_MAP[body.action];
      const clash = await app.prisma.twitchChatReward.findUnique({
        where: { channelId_rewardTitle_action: { channelId, rewardTitle: body.rewardTitle, action } },
      });
      if (clash) throw rewardExistsError(body.rewardTitle);

      const count = await app.prisma.twitchChatReward.count({ where: { channelId } });
      if (count >= TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL) {
        throw new AppError(
          'twitch_chat_reward_limit',
          `This channel has reached its limit of ${TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL} rewards.`,
          { status: 400, expose: true },
        );
      }

      // The checks above are a friendly fast path, not the real guarantee — the DB's compound unique
      // constraint (`@@unique([channelId, rewardTitle, action])`) is the actual guard against a concurrent
      // create for the same reward (same pattern as commands/timers above).
      let row;
      try {
        row = await app.prisma.twitchChatReward.create({
          data: {
            channelId,
            guildId,
            rewardId: body.rewardId ?? null,
            rewardTitle: body.rewardTitle,
            action,
            soundUrl: body.soundUrl ?? null,
            volume: body.volume ?? 80,
            ttsTemplate: body.ttsTemplate ?? null,
            chatTemplate: body.chatTemplate ?? null,
            discordChannelId: body.discordChannelId ?? null,
            discordTemplate: body.discordTemplate ?? null,
            cooldownSeconds: body.cooldownSeconds ?? 0,
            createdBy: session.userId,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw rewardExistsError(body.rewardTitle);
        throw err;
      }

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'integration.twitch_chat.reward.create',
        targetType: 'twitch_chat_reward',
        targetId: row.id,
        after: { channelId, rewardTitle: row.rewardTitle, action: row.action },
      });

      nudgeTwitchChatReconcile(app, guildId);

      reply.status(201);
      return toTwitchChatRewardDto(row);
    },
  );

  app.patch(
    '/:guildId/integrations/twitch-chat/rewards/:rewardId',
    {
      schema: { params: rewardParamSchema, body: updateTwitchChatRewardSchema },
      preHandler: requireGuildAccess(),
    },
    async (request): Promise<TwitchChatRewardDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { rewardId } = request.params as { rewardId: string };
      const body = request.body;

      const existing = await app.prisma.twitchChatReward.findFirst({ where: { id: rewardId, guildId } });
      if (!existing) throw new NotFoundError('Twitch chat reward not found.');

      if (body.soundUrl) await assertSafeSoundUrl(body.soundUrl);

      // `updateTwitchChatRewardSchema`'s superRefine only sees this request body in isolation, so when
      // `action` is present it already checked "every field this action doesn't use must be absent" against
      // the payload alone. What it can't check is the reward's *resulting* state once merged onto the
      // existing row — e.g. switching action to "sound" without also sending `soundUrl` in the same request
      // would otherwise silently save a SOUND reward with no sound to play. Validate that here instead.
      const effectiveActionId = body.action ?? TWITCH_REWARD_ACTION_MAP[existing.action];
      const spec = REWARD_ACTION_FIELD_SPEC[effectiveActionId];
      const merged: Record<RewardActionField, unknown> = {
        soundUrl: body.soundUrl !== undefined ? body.soundUrl : existing.soundUrl,
        volume: body.volume !== undefined ? body.volume : existing.volume,
        ttsTemplate: body.ttsTemplate !== undefined ? body.ttsTemplate : existing.ttsTemplate,
        chatTemplate: body.chatTemplate !== undefined ? body.chatTemplate : existing.chatTemplate,
        discordChannelId: body.discordChannelId !== undefined ? body.discordChannelId : existing.discordChannelId,
        discordTemplate: body.discordTemplate !== undefined ? body.discordTemplate : existing.discordTemplate,
      };
      for (const field of spec.required) {
        if (merged[field] === null || merged[field] === undefined) {
          throw new ValidationError(`"${field}" is required for the "${effectiveActionId}" action.`);
        }
      }

      if (body.rewardTitle !== undefined || body.action !== undefined) {
        const rewardTitle = body.rewardTitle ?? existing.rewardTitle;
        const action = TWITCH_REWARD_ACTION_ENUM_MAP[effectiveActionId];
        const clash = await app.prisma.twitchChatReward.findUnique({
          where: { channelId_rewardTitle_action: { channelId: existing.channelId, rewardTitle, action } },
        });
        if (clash && clash.id !== existing.id) throw rewardExistsError(rewardTitle);
      }

      // When the action is CHANGING, null out the previous action's now-irrelevant fields instead of leaving
      // stale values behind (mirrors create's "every other action's fields must be absent" rule). `volume` is
      // excluded — it's a non-nullable `Int @default(80)` column, and an unused leftover value there is
      // harmless (rewards.ts only reads it for SOUND actions).
      const clearOthers: Partial<Record<Exclude<RewardActionField, 'volume'>, null>> = {};
      if (body.action !== undefined && body.action !== TWITCH_REWARD_ACTION_MAP[existing.action]) {
        for (const field of REWARD_ACTION_FIELDS) {
          if (field !== 'volume' && !spec.allowed.includes(field)) clearOthers[field] = null;
        }
      }

      let updated;
      try {
        updated = await app.prisma.twitchChatReward.update({
          where: { id: rewardId },
          data: {
            ...clearOthers,
            ...(body.rewardId !== undefined ? { rewardId: body.rewardId } : {}),
            ...(body.rewardTitle !== undefined ? { rewardTitle: body.rewardTitle } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            ...(body.action !== undefined ? { action: TWITCH_REWARD_ACTION_ENUM_MAP[body.action] } : {}),
            ...(body.soundUrl !== undefined ? { soundUrl: body.soundUrl } : {}),
            ...(body.volume !== undefined ? { volume: body.volume } : {}),
            ...(body.ttsTemplate !== undefined ? { ttsTemplate: body.ttsTemplate } : {}),
            ...(body.chatTemplate !== undefined ? { chatTemplate: body.chatTemplate } : {}),
            ...(body.discordChannelId !== undefined ? { discordChannelId: body.discordChannelId } : {}),
            ...(body.discordTemplate !== undefined ? { discordTemplate: body.discordTemplate } : {}),
            ...(body.cooldownSeconds !== undefined ? { cooldownSeconds: body.cooldownSeconds } : {}),
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw rewardExistsError(body.rewardTitle ?? existing.rewardTitle);
        throw err;
      }

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'integration.twitch_chat.reward.update',
        targetType: 'twitch_chat_reward',
        targetId: rewardId,
        before: { rewardTitle: existing.rewardTitle, action: existing.action, enabled: existing.enabled },
        after: { rewardTitle: updated.rewardTitle, action: updated.action, enabled: updated.enabled },
      });

      nudgeTwitchChatReconcile(app, guildId);

      return toTwitchChatRewardDto(updated);
    },
  );

  app.delete(
    '/:guildId/integrations/twitch-chat/rewards/:rewardId',
    { schema: { params: rewardParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { rewardId } = request.params as { rewardId: string };

      const existing = await app.prisma.twitchChatReward.findFirst({ where: { id: rewardId, guildId } });
      if (!existing) throw new NotFoundError('Twitch chat reward not found.');

      await app.prisma.twitchChatReward.delete({ where: { id: rewardId } });

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'integration.twitch_chat.reward.delete',
        targetType: 'twitch_chat_reward',
        targetId: rewardId,
        before: { rewardTitle: existing.rewardTitle, action: existing.action },
      });

      nudgeTwitchChatReconcile(app, guildId);

      reply.status(204);
      return null;
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // Overlay token (OBS browser-source URL) — a capability token like `verify.ts`'s, stored ENCRYPTED. This
  // route only GENERATES/regenerates it; `apps/api/src/routes/overlay.ts` (owned separately) consumes it to
  // serve the overlay page/stream. The token itself is never logged or written to the audit trail.
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/integrations/twitch-chat/channels/:channelId/overlay',
    { schema: { params: channelParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<TwitchOverlayInfoDto> => {
      const guildId = request.guildId!;
      const { channelId } = request.params as { channelId: string };

      const channel = await app.prisma.twitchChatChannel.findFirst({ where: { id: channelId, guildId } });
      if (!channel) throw new NotFoundError('Twitch chat channel not found.');

      // Never auto-generates — the dashboard asks the admin to create one explicitly, and the full URL is
      // only ever handed back once, right after generate/regenerate (see the DTO's own doc comment).
      return { url: null, hasToken: Boolean(channel.overlayTokenEnc) };
    },
  );

  app.post(
    '/:guildId/integrations/twitch-chat/channels/:channelId/overlay/regenerate',
    { schema: { params: channelParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<TwitchOverlayInfoDto> => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { channelId } = request.params as { channelId: string };

      const channel = await app.prisma.twitchChatChannel.findFirst({ where: { id: channelId, guildId } });
      if (!channel) throw new NotFoundError('Twitch chat channel not found.');

      const hadToken = Boolean(channel.overlayTokenEnc);
      if (channel.overlayTokenEnc) {
        // Best-effort: drop the old token's Redis index so it stops resolving once replaced. If the old
        // ciphertext can't be decrypted (e.g. a rotated ENCRYPTION_KEY with no _PREVIOUS set) there's nothing
        // to clean up by key — it simply becomes an orphaned index entry, which is not a security issue since
        // resolving it still requires knowing the old token value.
        try {
          const oldToken = decryptSecret(channel.overlayTokenEnc);
          await app.redis.del(redisKey('overlay', 'token', oldToken));
        } catch {
          // Ignore — see comment above.
        }
      }

      const token = randomBytes(24).toString('hex');
      await app.prisma.twitchChatChannel.update({
        where: { id: channelId },
        data: { overlayTokenEnc: encryptSecret(token) },
      });
      // Durable lookup path for the SSE route (channel-points spec: "no TTL — it is the durable lookup path").
      await app.redis.set(redisKey('overlay', 'token', token), channelId);

      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: session.userId,
        action: 'integration.twitch_chat.overlay.regenerate',
        targetType: 'twitch_chat_channel',
        targetId: channelId,
        // The token/URL is a bearer credential — NEVER written to the audit payload, only whether one was
        // configured. (Field named to avoid `@pavisie/database`'s `redactForAudit`, which blanket-redacts any
        // key containing "token" — this is a plain boolean, not the secret itself, so it's fine to keep readable.)
        before: { configured: hadToken },
        after: { configured: true },
      });

      const url = `${env.API_BASE_URL ?? ''}/overlay/${token}`;
      return { url, hasToken: true };
    },
  );

  // ---------------------------------------------------------------------------------------------------------
  // "List rewards from Twitch" picker. The live Helix call (`listCustomRewards`,
  // packages/plugins/src/integrations/twitch-chat/helix.ts) needs a broadcaster-token `PluginContext` that
  // only the bot process constructs (a live discord.js client + bot-side services) — apps/api never builds
  // one, and can't import one in. The only established cross-process path (ARCHITECTURE.md §19) is the
  // `bot-actions` BullMQ queue, which is fire-and-forget API -> bot with no response channel back; building a
  // synchronous bot -> API round trip for this is new cross-process plumbing outside this route's scope
  // (channel-points spec, binding fact 6). So this endpoint honestly reports itself unavailable rather than
  // inventing that; the dashboard falls back to typing the reward title by hand, and the Discord
  // `/twitch reward` command (which runs inside the bot process, where the live Helix call is trivial) covers
  // the actual live picker.
  // ---------------------------------------------------------------------------------------------------------

  app.get(
    '/:guildId/integrations/twitch-chat/channels/:channelId/twitch-rewards',
    { schema: { params: channelParamSchema }, preHandler: requireGuildAccess() },
    async (request): Promise<{ available: boolean; rewards: { id: string; title: string }[] }> => {
      const guildId = request.guildId!;
      const { channelId } = request.params as { channelId: string };

      const channel = await app.prisma.twitchChatChannel.findFirst({ where: { id: channelId, guildId } });
      if (!channel) throw new NotFoundError('Twitch chat channel not found.');

      return { available: false, rewards: [] };
    },
  );
}
