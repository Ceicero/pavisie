import { z } from 'zod';
import { AppError, NotFoundError, ValidationError, encryptSecret } from '@pavisie/core';
import type { TwitchChatRewardDto, TwitchOverlayInfoDto } from '@pavisie/types/integrations';
import type { CreatorRewardsStatusDto, CreatorTtsKeyStatusDto } from '@pavisie/types/creator';
import type { ZodFastifyInstance } from '../lib/http';
import { TWITCH_REDEMPTIONS_SCOPE } from '../lib/creator/broadcaster-token';
import { requireTwitchCreator } from '../lib/creator/auth';
import { startTwitchCreatorConnect } from '../lib/creator/oauth';
import { TWITCH_REWARD_ACTION_MAP, toTwitchChatRewardDto } from '../lib/integrations/dto';
import { nudgeTwitchChatReconcile } from '../lib/integrations/twitch-chat-reconcile';
import {
  TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL,
  createTwitchChatRewardSchema,
  updateTwitchChatRewardSchema,
} from '../lib/integrations/twitch-chat-schemas';
import {
  REWARD_ACTION_FIELDS,
  REWARD_ACTION_FIELD_SPEC,
  TWITCH_REWARD_ACTION_ENUM_MAP,
  assertSafeSoundUrl,
  isUniqueViolation,
  rewardExistsError,
  type RewardActionField,
} from '../lib/integrations/twitch-chat-shared';
import { issueOverlayToken, overlayUrlFor, readOverlayToken } from '../lib/overlay-token';

const CREATOR_ROUTE_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
/** Tighter limit for the routes that mint a credential, start an OAuth round trip, or write a secret. */
const CREATOR_SENSITIVE_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

const rewardParamSchema = z.object({ rewardId: z.string().min(1) });

/** Posting a reward into a Discord channel is authorized by Discord permissions (a Discord admin of the linked
 * server), which a signed-in Twitch creator does not have — so a DISCORD action can be neither created nor edited
 * from the creator dashboard (phase 3's "connect a Discord server" adds a proper, verified Discord connection). */
const DISCORD_ACTION_MESSAGE =
  'Posting a reward to Discord is set up from the Discord dashboard, not the creator dashboard.';

const noDiscordAction = (data: { action?: string }): boolean => data.action !== 'discord';
const noDiscordFields = (data: { discordChannelId?: unknown; discordTemplate?: unknown }): boolean =>
  data.discordChannelId === undefined && data.discordTemplate === undefined;

const createCreatorRewardSchema = createTwitchChatRewardSchema
  .refine(noDiscordAction, { path: ['action'], message: DISCORD_ACTION_MESSAGE })
  .refine(noDiscordFields, { path: ['discordChannelId'], message: DISCORD_ACTION_MESSAGE });

const updateCreatorRewardSchema = updateTwitchChatRewardSchema
  .refine(noDiscordAction, { path: ['action'], message: DISCORD_ACTION_MESSAGE })
  .refine(noDiscordFields, { path: ['discordChannelId'], message: DISCORD_ACTION_MESSAGE });

/** Only the master switch is a creator setting here (everything else has its own route). */
const updateRewardsSettingsSchema = z.object({ rewardsEnabled: z.boolean() }).strict();

/** OpenAI secret keys are `sk-...` (`sk-proj-...` for project keys). Loose on purpose — it only catches a
 * pasted-the-wrong-thing slip; OpenAI itself is the judge of whether the key works. */
const ttsKeySchema = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(20, 'That does not look like an OpenAI API key.')
      .max(300, 'That does not look like an OpenAI API key.')
      .regex(/^sk-\S+$/, 'An OpenAI API key starts with "sk-" and has no spaces.'),
  })
  .strict();

/**
 * `/creator/twitch/rewards/*` — channel-point rewards, the OBS overlay and the bring-your-own-key TTS setting for a
 * signed-in Twitch creator's OWN channel, with or without a Discord server (ARCHITECTURE.md §19b / §19e; creator
 * dashboard phase 2b).
 *
 * Same rules as `routes/creator-twitch.ts`: the channel is never addressed by id — it is always looked up from the
 * session (`broadcasterUserId` = the creator's Twitch id) — so someone else's channel is unreachable; an absent
 * channel, or a reward id belonging to another channel, is a 404 (never a 403). Every route needs a creator session
 * (401 otherwise); every mutating route also needs that session's CSRF token (`lib/csrf.ts`). No audit-log rows: the
 * audit log is per Discord guild and a creator action has no Discord actor.
 *
 * Secrets: the overlay URL is a capability secret, returned only here (owner-only, `Cache-Control: no-store`) and
 * never logged; the TTS OpenAI key is write-only — stored encrypted, never returned, only "set / not set".
 */
export default async function creatorTwitchRewardsRoutes(app: ZodFastifyInstance): Promise<void> {
  async function findOwnChannel(creatorUserId: string) {
    return app.prisma.twitchChatChannel.findFirst({ where: { broadcasterUserId: creatorUserId } });
  }

  async function requireOwnChannel(creatorUserId: string) {
    const channel = await findOwnChannel(creatorUserId);
    if (!channel) throw new NotFoundError('Twitch chat channel not found.');
    return channel;
  }

  async function findToken(channelId: string) {
    return app.prisma.twitchBroadcasterToken.findUnique({ where: { channelId } });
  }

  function isUsableToken(token: { scopes: string[]; status: string } | null): boolean {
    return Boolean(token && token.scopes.includes(TWITCH_REDEMPTIONS_SCOPE) && token.status !== 'ERROR');
  }

  function nudge(channel: { guildId: string | null }): void {
    nudgeTwitchChatReconcile(app, channel.guildId ?? '');
  }

  // -----------------------------------------------------------------------------------------------------------
  // Status + master switch + authorization
  // -----------------------------------------------------------------------------------------------------------

  app.get(
    '/',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorRewardsStatusDto> => {
      const channel = await findOwnChannel(request.creator!.platformUserId);
      if (!channel) {
        return {
          channelExists: false,
          channelEnabled: false,
          rewardsEnabled: false,
          authorized: false,
          authorizationError: null,
          hasOverlay: false,
          ttsKeyConfigured: false,
          discordLinked: false,
          maxRewards: TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL,
        };
      }
      const token = await findToken(channel.id);
      return {
        channelExists: true,
        channelEnabled: channel.enabled,
        rewardsEnabled: channel.rewardsEnabled,
        authorized: isUsableToken(token),
        authorizationError: token?.status === 'ERROR' ? token.lastError : null,
        hasOverlay: Boolean(channel.overlayTokenEnc),
        ttsKeyConfigured: Boolean(channel.ttsOpenAiKeyEnc),
        discordLinked: channel.guildId !== null,
        maxRewards: TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL,
      };
    },
  );

  app.patch(
    '/',
    { ...CREATOR_ROUTE_RATE_LIMIT, schema: { body: updateRewardsSettingsSchema }, preHandler: requireTwitchCreator },
    async (request): Promise<{ rewardsEnabled: boolean }> => {
      const { rewardsEnabled } = request.body;
      const channel = await requireOwnChannel(request.creator!.platformUserId);

      if (rewardsEnabled && !isUsableToken(await findToken(channel.id))) {
        throw new AppError(
          'channel_points_not_authorized',
          'Authorize channel points first — Pavisie needs your permission to see redemptions.',
          { status: 409, expose: true },
        );
      }

      const updated = await app.prisma.twitchChatChannel.update({
        where: { id: channel.id },
        data: { rewardsEnabled },
      });
      nudge(channel);
      return { rewardsEnabled: updated.rewardsEnabled };
    },
  );

  // Starts (or re-starts) "enable channel points": the same reused Twitch redirect URI and creator-connect state as
  // the chat-bot connect, but for `channel:bot channel:read:redemptions`, and the callback KEEPS the token. It
  // refuses any Twitch account other than the signed-in creator (`lib/creator/oauth.ts`).
  app.post(
    '/authorize',
    { ...CREATOR_SENSITIVE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<{ url: string }> => {
      const url = await startTwitchCreatorConnect(app.redis, request.creator!, 'channel-points');
      return { url };
    },
  );

  // Disconnect channel points: forget the broadcaster token and switch rewards off. Rewards, the overlay URL and
  // the TTS key are left as they are (re-authorizing later brings them straight back).
  app.delete(
    '/authorize',
    { ...CREATOR_SENSITIVE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request, reply) => {
      const channel = await requireOwnChannel(request.creator!.platformUserId);
      await app.prisma.twitchBroadcasterToken.deleteMany({ where: { channelId: channel.id } });
      await app.prisma.twitchChatChannel.update({ where: { id: channel.id }, data: { rewardsEnabled: false } });
      nudge(channel);
      reply.status(204);
      return null;
    },
  );

  // -----------------------------------------------------------------------------------------------------------
  // Rewards CRUD (same validation and limits as the Discord dashboard's routes; no DISCORD action here)
  // -----------------------------------------------------------------------------------------------------------

  app.get(
    '/items',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<TwitchChatRewardDto[]> => {
      const channel = await requireOwnChannel(request.creator!.platformUserId);
      const rows = await app.prisma.twitchChatReward.findMany({
        where: { channelId: channel.id },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toTwitchChatRewardDto);
    },
  );

  app.post(
    '/items',
    { ...CREATOR_ROUTE_RATE_LIMIT, schema: { body: createCreatorRewardSchema }, preHandler: requireTwitchCreator },
    async (request, reply): Promise<TwitchChatRewardDto> => {
      const creator = request.creator!;
      const body = request.body;
      const channel = await requireOwnChannel(creator.platformUserId);

      // The zod schema only checks URL shape (https, well-formed) — the live DNS lookup that catches
      // private/internal/metadata targets happens here.
      if (body.soundUrl) await assertSafeSoundUrl(body.soundUrl);

      const action = TWITCH_REWARD_ACTION_ENUM_MAP[body.action];
      const clash = await app.prisma.twitchChatReward.findUnique({
        where: { channelId_rewardTitle_action: { channelId: channel.id, rewardTitle: body.rewardTitle, action } },
      });
      if (clash) throw rewardExistsError(body.rewardTitle);

      const count = await app.prisma.twitchChatReward.count({ where: { channelId: channel.id } });
      if (count >= TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL) {
        throw new AppError(
          'twitch_chat_reward_limit',
          `This channel has reached its limit of ${TWITCH_CHAT_MAX_REWARDS_PER_CHANNEL} rewards.`,
          { status: 400, expose: true },
        );
      }

      // Friendly fast path above; the DB's compound unique is the real guard against a concurrent create.
      let row;
      try {
        row = await app.prisma.twitchChatReward.create({
          data: {
            channelId: channel.id,
            // The channel's own guild link, if any (null for a guildless channel).
            guildId: channel.guildId,
            rewardId: body.rewardId ?? null,
            rewardTitle: body.rewardTitle,
            action,
            soundUrl: body.soundUrl ?? null,
            volume: body.volume ?? 80,
            ttsTemplate: body.ttsTemplate ?? null,
            chatTemplate: body.chatTemplate ?? null,
            discordChannelId: null,
            discordTemplate: null,
            cooldownSeconds: body.cooldownSeconds ?? 0,
            createdBy: creator.platformUserId,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw rewardExistsError(body.rewardTitle);
        throw err;
      }

      nudge(channel);
      reply.status(201);
      return toTwitchChatRewardDto(row);
    },
  );

  app.patch(
    '/items/:rewardId',
    {
      ...CREATOR_ROUTE_RATE_LIMIT,
      schema: { params: rewardParamSchema, body: updateCreatorRewardSchema },
      preHandler: requireTwitchCreator,
    },
    async (request): Promise<TwitchChatRewardDto> => {
      const { rewardId } = request.params;
      const body = request.body;
      const channel = await requireOwnChannel(request.creator!.platformUserId);

      const existing = await app.prisma.twitchChatReward.findFirst({ where: { id: rewardId, channelId: channel.id } });
      if (!existing) throw new NotFoundError('Twitch chat reward not found.');
      if (existing.action === 'DISCORD') throw new ValidationError(DISCORD_ACTION_MESSAGE);

      if (body.soundUrl) await assertSafeSoundUrl(body.soundUrl);

      // The schema only saw this request body in isolation; validate the reward's RESULTING state (existing row
      // merged with the patch), e.g. switching to "sound" without a sound URL must not save a silent reward.
      const effectiveActionId = body.action ?? TWITCH_REWARD_ACTION_MAP[existing.action];
      const spec = REWARD_ACTION_FIELD_SPEC[effectiveActionId];
      const merged: Record<RewardActionField, unknown> = {
        soundUrl: body.soundUrl !== undefined ? body.soundUrl : existing.soundUrl,
        volume: body.volume !== undefined ? body.volume : existing.volume,
        ttsTemplate: body.ttsTemplate !== undefined ? body.ttsTemplate : existing.ttsTemplate,
        chatTemplate: body.chatTemplate !== undefined ? body.chatTemplate : existing.chatTemplate,
        discordChannelId: existing.discordChannelId,
        discordTemplate: existing.discordTemplate,
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
          where: { channelId_rewardTitle_action: { channelId: channel.id, rewardTitle, action } },
        });
        if (clash && clash.id !== existing.id) throw rewardExistsError(rewardTitle);
      }

      // When the action is CHANGING, null out the previous action's now-irrelevant fields (`volume` excluded — it is
      // a non-nullable column and a leftover value is harmless).
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
            ...(body.cooldownSeconds !== undefined ? { cooldownSeconds: body.cooldownSeconds } : {}),
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw rewardExistsError(body.rewardTitle ?? existing.rewardTitle);
        throw err;
      }

      nudge(channel);
      return toTwitchChatRewardDto(updated);
    },
  );

  app.delete(
    '/items/:rewardId',
    { ...CREATOR_ROUTE_RATE_LIMIT, schema: { params: rewardParamSchema }, preHandler: requireTwitchCreator },
    async (request, reply) => {
      const { rewardId } = request.params;
      const channel = await requireOwnChannel(request.creator!.platformUserId);

      const existing = await app.prisma.twitchChatReward.findFirst({ where: { id: rewardId, channelId: channel.id } });
      if (!existing) throw new NotFoundError('Twitch chat reward not found.');
      if (existing.action === 'DISCORD') throw new ValidationError(DISCORD_ACTION_MESSAGE);

      await app.prisma.twitchChatReward.delete({ where: { id: rewardId } });

      nudge(channel);
      reply.status(204);
      return null;
    },
  );

  // -----------------------------------------------------------------------------------------------------------
  // OBS overlay URL (capability secret — owner only, never cached, never logged)
  // -----------------------------------------------------------------------------------------------------------

  // Shows the current overlay URL to its owner. Never creates one — the streamer does that explicitly with
  // `POST /overlay/regenerate`.
  app.get(
    '/overlay',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request, reply): Promise<TwitchOverlayInfoDto> => {
      const channel = await requireOwnChannel(request.creator!.platformUserId);
      reply.header('Cache-Control', 'no-store');
      const token = readOverlayToken(channel);
      return { url: token ? overlayUrlFor(token) : null, hasToken: Boolean(channel.overlayTokenEnc) };
    },
  );

  // Creates the overlay URL, or ROTATES it: the previous URL stops working immediately (any OBS browser source
  // still pointing at it goes blank until the new URL is pasted in).
  app.post(
    '/overlay/regenerate',
    { ...CREATOR_SENSITIVE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request, reply): Promise<TwitchOverlayInfoDto> => {
      const channel = await requireOwnChannel(request.creator!.platformUserId);
      const { token } = await issueOverlayToken(app.redis, app.prisma, channel);
      reply.header('Cache-Control', 'no-store');
      return { url: overlayUrlFor(token), hasToken: true };
    },
  );

  // -----------------------------------------------------------------------------------------------------------
  // Bring-your-own-key TTS: the channel's own OpenAI key. WRITE-ONLY — stored encrypted, never returned.
  // -----------------------------------------------------------------------------------------------------------

  app.put(
    '/tts-key',
    { ...CREATOR_SENSITIVE_RATE_LIMIT, schema: { body: ttsKeySchema }, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorTtsKeyStatusDto> => {
      const channel = await requireOwnChannel(request.creator!.platformUserId);
      await app.prisma.twitchChatChannel.update({
        where: { id: channel.id },
        data: { ttsOpenAiKeyEnc: encryptSecret(request.body.apiKey) },
      });
      // The bot reads the channel row on its next reconcile pass; nudging just makes that prompt.
      nudge(channel);
      return { ttsKeyConfigured: true };
    },
  );

  app.delete(
    '/tts-key',
    { ...CREATOR_SENSITIVE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorTtsKeyStatusDto> => {
      const channel = await requireOwnChannel(request.creator!.platformUserId);
      await app.prisma.twitchChatChannel.update({ where: { id: channel.id }, data: { ttsOpenAiKeyEnc: null } });
      nudge(channel);
      return { ttsKeyConfigured: false };
    },
  );
}
