import { z } from 'zod';
import { AppError, NotFoundError, PermissionError } from '@pavisie/core';
import type { DiscordChannelOption } from '@pavisie/types';
import type {
  CreatorDiscordBridgeDto,
  CreatorDiscordCandidatesDto,
  CreatorDiscordStatusDto,
} from '@pavisie/types/creator';
import type { TwitchChatChannel } from '@pavisie/database';
import { writeDashboardAudit } from '../lib/audit';
import { getCachedGuildChannels, buildGuildIconUrl } from '../lib/discord';
import type { ZodFastifyInstance } from '../lib/http';
import { requireTwitchCreator } from '../lib/creator/auth';
import {
  clearDiscordCandidates,
  isDiscordOAuthConfigured,
  linkChannelToGuild,
  readDiscordCandidates,
  startDiscordCreatorConnect,
  toCreatorDiscordServerDto,
  unlinkChannelFromGuild,
} from '../lib/creator/discord-link';
import { currentCreatorSid } from '../lib/creator/session';
import { prepareBridgeUpdate } from '../lib/integrations/twitch-bridge-shared';
import { nudgeTwitchChatReconcile } from '../lib/integrations/twitch-chat-reconcile';
import { snowflakeSchema } from '../lib/schemas';

const CREATOR_ROUTE_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
/** Tighter limit for the routes that start an OAuth round trip or link/unlink a server. */
const CREATOR_SENSITIVE_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

const linkBodySchema = z.object({ guildId: snowflakeSchema }).strict();

/** The creator can change only the bridge fields here; anything else (a smuggled `guildId`, `enabled`...) is a 400. */
const updateBridgeSchema = z
  .object({
    discordChannelId: snowflakeSchema.nullable().optional(),
    discordToTwitch: z.boolean().optional(),
    twitchToDiscord: z.boolean().optional(),
  })
  .strict();

/** The bridge is configured against a server the creator proved they manage; a link a Discord admin made from the
 * Discord dashboard is not that, so it must be disconnected and connected again from here first. */
const UNVERIFIED_MESSAGE =
  'This channel was linked to Discord from a server\'s own dashboard. Disconnect it and connect the server again from here (you will sign into Discord once) to manage the bridge and Discord rewards.';

function toBridgeDto(row: TwitchChatChannel): CreatorDiscordBridgeDto {
  return {
    discordChannelId: row.bridgeDiscordChannelId,
    discordToTwitch: row.bridgeDiscordToTwitch,
    twitchToDiscord: row.bridgeTwitchToDiscord,
    lastError: row.bridgeLastError,
  };
}

/**
 * `/creator/twitch/discord/*` — the OPTIONAL Discord add-on for a signed-in Twitch creator (ARCHITECTURE.md §19e,
 * phase 3): connect a Discord server they manage, configure the Discord <-> Twitch chat bridge, disconnect.
 *
 * Same rules as the other creator routes: the channel is never addressed by id — always looked up from the session —
 * so another creator's channel is unreachable, and an absent channel is a 404 (never a 403). Every route needs a
 * creator session (401 otherwise); every mutating route also needs that session's CSRF token (`lib/csrf.ts`). The
 * connect flow's Discord token is never stored; linking accepts only a guild id from the candidate list stashed for
 * THIS creator session by the Discord sign-in (`lib/creator/discord-link.ts`) — never a client-supplied trust.
 */
export default async function creatorTwitchDiscordRoutes(app: ZodFastifyInstance): Promise<void> {
  async function findOwnChannel(creatorUserId: string) {
    return app.prisma.twitchChatChannel.findFirst({ where: { broadcasterUserId: creatorUserId } });
  }

  async function requireOwnChannel(creatorUserId: string) {
    const channel = await findOwnChannel(creatorUserId);
    if (!channel) throw new NotFoundError('Twitch chat channel not found.');
    return channel;
  }

  /** The channel, and the server it is linked to — only when the creator verified that link from this dashboard. */
  async function requireVerifiedLink(creatorUserId: string): Promise<{ channel: TwitchChatChannel; guildId: string }> {
    const channel = await requireOwnChannel(creatorUserId);
    if (!channel.guildId) throw new NotFoundError('No Discord server is connected.');
    if (!channel.discordLinkedBy) {
      throw new AppError('discord_link_unverified', UNVERIFIED_MESSAGE, { status: 409, expose: true });
    }
    return { channel, guildId: channel.guildId };
  }

  // -----------------------------------------------------------------------------------------------------------
  // Connect flow
  // -----------------------------------------------------------------------------------------------------------

  // Starts "connect a Discord server": the browser is sent to Discord to sign in, then comes back through the
  // already-registered dashboard-login redirect URI (`routes/auth.ts` dispatches creator states to
  // `completeDiscordCreatorConnect`) and lands on `/creator?discord=pick`. A top-level GET redirect like the Twitch
  // sign-in (the state is bound to this browser by a signed cookie and to this creator by the session).
  app.get(
    '/connect',
    { ...CREATOR_SENSITIVE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request, reply) => {
      const url = await startDiscordCreatorConnect(app, request, reply);
      reply.redirect(url);
    },
  );

  app.get(
    '/',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorDiscordStatusDto> => {
      const channel = await findOwnChannel(request.creator!.platformUserId);
      const base = {
        configured: isDiscordOAuthConfigured(),
        hasChannel: Boolean(channel),
        linked: Boolean(channel?.guildId),
        verified: false,
        server: null,
        linkedAt: null,
        integrationsEnabled: false,
      } satisfies CreatorDiscordStatusDto;
      if (!channel?.guildId) return base;

      const integrationsEnabled = await app.configStore.isEnabled(channel.guildId, 'integrations');
      if (!channel.discordLinkedBy) return { ...base, integrationsEnabled };

      // Only a link the creator verified reveals the server's name/icon here.
      const guild = await app.prisma.guild.findUnique({ where: { id: channel.guildId } });
      return {
        ...base,
        verified: true,
        server: {
          id: channel.guildId,
          name: guild?.name ?? 'Discord server',
          iconUrl: buildGuildIconUrl(channel.guildId, guild?.iconHash),
        },
        linkedAt: channel.discordLinkedAt?.toISOString() ?? null,
        integrationsEnabled,
      };
    },
  );

  app.get(
    '/candidates',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorDiscordCandidatesDto> => {
      const sid = currentCreatorSid(request);
      const stash = sid ? await readDiscordCandidates(app.redis, sid) : null;
      return { pending: Boolean(stash), candidates: (stash?.guilds ?? []).map(toCreatorDiscordServerDto) };
    },
  );

  app.post(
    '/link',
    { ...CREATOR_SENSITIVE_RATE_LIMIT, schema: { body: linkBodySchema }, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorDiscordStatusDto> => {
      const creator = request.creator!;
      const { guildId } = request.body;
      const channel = await requireOwnChannel(creator.platformUserId);

      const sid = currentCreatorSid(request);
      const stash = sid ? await readDiscordCandidates(app.redis, sid) : null;
      if (!stash) {
        throw new AppError(
          'discord_sign_in_required',
          'Sign into Discord again to connect a server — the earlier sign-in has expired.',
          { status: 409, expose: true },
        );
      }
      // Never trust the client: only a server the Discord sign-in found for THIS session (managed by the user, bot
      // present) can be linked.
      if (!stash.guilds.some((g) => g.id === guildId)) {
        throw new PermissionError('That server is not one you manage where Pavisie is a member.');
      }

      const updated = await linkChannelToGuild(app, { channel, guildId, discordUserId: stash.discordUserId });
      // One Discord sign-in proves one link.
      if (sid) await clearDiscordCandidates(app.redis, sid);

      const guild = await app.prisma.guild.findUnique({ where: { id: guildId } });
      return {
        configured: isDiscordOAuthConfigured(),
        hasChannel: true,
        linked: true,
        verified: true,
        server: {
          id: guildId,
          name: guild?.name ?? 'Discord server',
          iconUrl: buildGuildIconUrl(guildId, guild?.iconHash),
        },
        linkedAt: updated.discordLinkedAt?.toISOString() ?? null,
        // Linking never changes the server's plugin settings (phase 4): report what the server admin has set, so the
        // dashboard can say the bridge and Discord posts are paused while the Integrations plugin is off.
        integrationsEnabled: await app.configStore.isEnabled(guildId, 'integrations'),
      };
    },
  );

  // Disconnect the Discord server (see `unlinkChannelFromGuild` for exactly what is kept and what is removed). Works
  // for a link the creator made here AND for one a Discord admin made from the Discord dashboard — it is the
  // creator's own channel — and is how an unverified link gets re-made as a verified one.
  app.delete(
    '/link',
    { ...CREATOR_SENSITIVE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request, reply) => {
      const creator = request.creator!;
      const channel = await requireOwnChannel(creator.platformUserId);
      if (!channel.guildId) throw new NotFoundError('No Discord server is connected.');
      await unlinkChannelFromGuild(app, { channel, actor: { id: creator.platformUserId, platform: 'twitch' } });
      reply.status(204);
      return null;
    },
  );

  // -----------------------------------------------------------------------------------------------------------
  // Pickers + bridge (only for a server the creator verified)
  // -----------------------------------------------------------------------------------------------------------

  // The linked server's channels, for the bridge and Discord-reward pickers (bot-token read, cached 60s per guild —
  // same source as the Discord dashboard's pickers). The list is only of the ONE server linked to the creator's own
  // channel; no guild id is accepted from the client.
  app.get(
    '/channels',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<DiscordChannelOption[]> => {
      const { guildId } = await requireVerifiedLink(request.creator!.platformUserId);
      return getCachedGuildChannels(app.redis, guildId);
    },
  );

  app.get(
    '/bridge',
    { ...CREATOR_ROUTE_RATE_LIMIT, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorDiscordBridgeDto> => {
      const { channel } = await requireVerifiedLink(request.creator!.platformUserId);
      return toBridgeDto(channel);
    },
  );

  app.patch(
    '/bridge',
    { ...CREATOR_ROUTE_RATE_LIMIT, schema: { body: updateBridgeSchema }, preHandler: requireTwitchCreator },
    async (request): Promise<CreatorDiscordBridgeDto> => {
      const { channel: existing, guildId } = await requireVerifiedLink(request.creator!.platformUserId);
      const body = request.body;

      // The same validation, old-webhook tidying and resulting-state check as the Discord dashboard's route.
      const data = await prepareBridgeUpdate(app, guildId, existing, {
        bridgeDiscordChannelId: body.discordChannelId,
        bridgeDiscordToTwitch: body.discordToTwitch,
        bridgeTwitchToDiscord: body.twitchToDiscord,
      });
      if (Object.keys(data).length === 0) return toBridgeDto(existing);
      const updated = await app.prisma.twitchChatChannel.update({ where: { id: existing.id }, data });

      // The bridge relays text into a channel of the linked server, so the server's admins get an audit entry (the
      // actor is the Twitch creator, not a Discord user).
      await writeDashboardAudit(app.prisma, {
        guildId,
        actorId: `twitch:${request.creator!.platformUserId}`,
        action: 'integration.twitch_chat.discord.bridge.update',
        targetType: 'twitch_chat_channel',
        targetId: existing.id,
        before: toBridgeDto(existing),
        after: toBridgeDto(updated),
      });

      nudgeTwitchChatReconcile(app, guildId);
      return toBridgeDto(updated);
    },
  );
}
