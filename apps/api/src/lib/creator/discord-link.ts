import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import type { TwitchChatChannel } from '@pavisie/database';
import {
  AppError,
  NotFoundError,
  PermissionError,
  ValidationError,
  env,
  isProduction,
  redisKey,
} from '@pavisie/core';
import type { CreatorDiscordServerDto } from '@pavisie/types/creator';
import { writeDashboardAudit } from '../audit';
import {
  buildAuthorizeUrl,
  buildGuildIconUrl,
  exchangeCode,
  fetchDiscordUser,
  fetchDiscordUserGuildsUncached,
  hasManageAccess,
  revokeDiscordToken,
} from '../discord';
import { UnauthenticatedError } from '../guild-access';
import type { ZodFastifyInstance } from '../http';
import { deleteBridgeWebhookBestEffort } from '../integrations/twitch-bridge-shared';
import { nudgeTwitchChatReconcile } from '../integrations/twitch-chat-reconcile';
import { creatorDashboardUrl } from './oauth';
import { currentCreatorSid, readSignedCookie } from './session';

/**
 * "Connect a Discord server" from the creator dashboard (ARCHITECTURE.md §19e, phase 3).
 *
 * A signed-in Twitch creator signs into Discord ONCE, to PROVE they can manage a server (Manage Server /
 * Administrator / owner) where the Pavisie bot is present, then picks one; that server is linked to their
 * `TwitchChatChannel` (`guildId`). The flow reuses the ALREADY-REGISTERED Discord redirect URI
 * (`/auth/discord/callback`, `DISCORD_OAUTH_REDIRECT_URI`) — nothing new to register in the Discord Developer
 * Portal: `routes/auth.ts`'s callback looks the returned `state` up in the creator namespace below first
 * (`detectCreatorDiscordCallback`) and hands a hit to `completeDiscordCreatorConnect`; anything else is the Discord
 * dashboard login, unchanged. Scopes are the login's own (`identify guilds`) — nothing broader.
 *
 * The Discord access token lives only inside `completeDiscordCreatorConnect`: used for two reads (who am I, my
 * guilds), revoked best-effort, NEVER stored. It never creates or touches a Discord dashboard `sid` session.
 */

const CREATOR_DISCORD_STATE_TTL_SECONDS = 600;
/** How long the candidate list survives after the Discord sign-in: long enough to pick, short enough that a stale
 * permission (someone demoted meanwhile) cannot be acted on much later. */
const CREATOR_DISCORD_CANDIDATES_TTL_SECONDS = 600;

/** Signed, httpOnly pre-flow cookie binding a creator-Discord `state` to the browser that started it (RFC 6749
 * section 10.12) — same reasoning and `sameSite: 'lax'` requirement as `oauth_state` in routes/auth.ts: the callback
 * is a top-level GET redirect from Discord, which Lax cookies ride along on and Strict ones do not. */
export const CREATOR_DISCORD_STATE_COOKIE_NAME = 'creator_discord_state';

export function creatorDiscordStateKey(state: string): string {
  return redisKey('creator-discord-state', state);
}

/** The stashed candidate list is keyed to the creator SESSION id, so it is unreachable from any other session. */
export function creatorDiscordCandidatesKey(creatorSid: string): string {
  return redisKey('creator-discord-candidates', creatorSid);
}

/** A Discord server found on the sign-in: the creator manages it and the bot is a member. */
export interface DiscordCandidate {
  id: string;
  name: string;
  icon: string | null;
}

/** What is held (briefly) after a completed Discord sign-in. `discordUserId` is what gets recorded on the link. */
export interface DiscordCandidatesStash {
  discordUserId: string;
  guilds: DiscordCandidate[];
}

export function toCreatorDiscordServerDto(guild: DiscordCandidate): CreatorDiscordServerDto {
  return { id: guild.id, name: guild.name, iconUrl: buildGuildIconUrl(guild.id, guild.icon) };
}

export async function readDiscordCandidates(redis: Redis, creatorSid: string): Promise<DiscordCandidatesStash | null> {
  const raw = await redis.get(creatorDiscordCandidatesKey(creatorSid));
  return raw ? (JSON.parse(raw) as DiscordCandidatesStash) : null;
}

export async function clearDiscordCandidates(redis: Redis, creatorSid: string): Promise<void> {
  await redis.del(creatorDiscordCandidatesKey(creatorSid));
}

function setStateCookie(reply: FastifyReply, state: string): void {
  reply.setCookie(CREATOR_DISCORD_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: CREATOR_DISCORD_STATE_TTL_SECONDS,
    signed: true,
  });
}

function clearStateCookie(reply: FastifyReply): void {
  reply.clearCookie(CREATOR_DISCORD_STATE_COOKIE_NAME, { path: '/' });
}

export function isDiscordOAuthConfigured(): boolean {
  return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.DISCORD_OAUTH_REDIRECT_URI);
}

/**
 * `GET /creator/twitch/discord/connect`: stores a fresh single-use state naming the signed-in creator, binds it to
 * this browser, and returns the Discord authorize URL (the login's own scopes, `prompt=consent` so Discord always
 * asks — the creator really signs in). Requires the creator session (the caller's preHandler).
 */
export async function startDiscordCreatorConnect(
  app: ZodFastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string> {
  const creator = request.creator;
  if (!creator) throw new UnauthenticatedError();
  const state = randomBytes(24).toString('hex');
  // `buildAuthorizeUrl` throws `ExternalServiceError` when Discord OAuth is not configured — before any state is stored.
  const url = buildAuthorizeUrl(state);
  await app.redis.set(
    creatorDiscordStateKey(state),
    JSON.stringify({ platform: creator.platform, platformUserId: creator.platformUserId }),
    'EX',
    CREATOR_DISCORD_STATE_TTL_SECONDS,
  );
  setStateCookie(reply, state);
  return url;
}

/**
 * Is this `/auth/discord/callback` state one of the creator flow's? Checked BEFORE the dashboard login's own
 * browser-binding/state checks. A state whose Redis entry is gone but whose signed cookie still matches counts too,
 * so an expired/replayed creator state gets the proper message instead of a confusing dashboard-login error.
 */
export async function detectCreatorDiscordCallback(
  redis: Redis,
  request: FastifyRequest,
  state: string,
): Promise<boolean> {
  if (await redis.exists(creatorDiscordStateKey(state))) return true;
  return readSignedCookie(request, CREATOR_DISCORD_STATE_COOKIE_NAME) === state;
}

interface CreatorDiscordStatePayload {
  platform: string;
  platformUserId: string;
}

/**
 * The creator-Discord callback. Order matters and mirrors the dashboard login: browser binding first (a wrong
 * browser does NOT consume the state), then the creator session (the `csid` cookie rides the top-level GET), then the
 * single-use state — which must have been issued to THAT creator — then the code exchange. The token is used for two
 * reads and discarded; the candidate list (guilds the user manages where the bot is a member) is stashed briefly,
 * keyed to the creator session, and the browser goes back to the creator dashboard's pick screen.
 */
export async function completeDiscordCreatorConnect(
  app: ZodFastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  input: { code: string; state: string },
): Promise<void> {
  const { code, state } = input;

  const cookieState = readSignedCookie(request, CREATOR_DISCORD_STATE_COOKIE_NAME);
  if (!cookieState || cookieState !== state) {
    throw new ValidationError(
      'This connect link does not match the browser that started it. Please start again from the creator dashboard.',
    );
  }
  clearStateCookie(reply);

  const creator = request.creator;
  const creatorSid = currentCreatorSid(request);
  if (!creator || !creatorSid) throw new UnauthenticatedError();

  const stateKey = creatorDiscordStateKey(state);
  const raw = await app.redis.get(stateKey);
  if (!raw) {
    throw new ValidationError(
      'This connect link has expired or was already used. Please start again from the creator dashboard.',
    );
  }
  const payload = JSON.parse(raw) as CreatorDiscordStatePayload;
  if (payload.platform !== creator.platform || payload.platformUserId !== creator.platformUserId) {
    throw new PermissionError(
      'This connect link was started from a different account. Start it again while signed in as the account that will connect.',
    );
  }
  await app.redis.del(stateKey);

  const token = await exchangeCode(code);
  let discordUserId: string;
  let guilds;
  try {
    const user = await fetchDiscordUser(token.access_token);
    discordUserId = user.id;
    guilds = await fetchDiscordUserGuildsUncached(token.access_token);
  } finally {
    await revokeDiscordToken(token.access_token);
  }

  // Manage Server / Administrator / owner — the same rule the Discord dashboard applies (`hasManageAccess`) — AND the
  // bot must be a member (`Guild.botPresent`, the table the bot keeps in sync on guildCreate/guildDelete).
  const manageable = guilds.filter((g) => hasManageAccess(g.permissions, g.owner));
  const present = manageable.length
    ? await app.prisma.guild.findMany({
        where: { id: { in: manageable.map((g) => g.id) }, botPresent: true },
        select: { id: true },
      })
    : [];
  const presentIds = new Set(present.map((g) => g.id));
  const candidates: DiscordCandidate[] = manageable
    .filter((g) => presentIds.has(g.id))
    .map((g) => ({ id: g.id, name: g.name, icon: g.icon }));

  const stash: DiscordCandidatesStash = { discordUserId, guilds: candidates };
  await app.redis.set(
    creatorDiscordCandidatesKey(creatorSid),
    JSON.stringify(stash),
    'EX',
    CREATOR_DISCORD_CANDIDATES_TTL_SECONDS,
  );

  reply.redirect(creatorDashboardUrl({ discord: 'pick' }));
}

// ---------------------------------------------------------------------------------------------------------------
// Link / unlink (shared with the Discord dashboard's own "remove the Twitch channel" action)
// ---------------------------------------------------------------------------------------------------------------

/** The plugin that owns the Twitch chat bot; while a server is linked, the bot only runs for the channel while this
 * plugin is enabled in that server (`TwitchChatManager.computeDesiredChannels`). */
const TWITCH_CHAT_PLUGIN_ID = 'integrations' as const;

export function alreadyLinkedElsewhereError(): AppError {
  return new AppError(
    'discord_already_linked',
    'This channel is already connected to a different Discord server. Disconnect it first, then connect the new one.',
    { status: 409, expose: true },
  );
}

const NO_BRIDGE_DATA = {
  bridgeDiscordChannelId: null,
  bridgeDiscordToTwitch: false,
  bridgeTwitchToDiscord: false,
  bridgeWebhookId: null,
  bridgeWebhookTokenEnc: null,
  bridgeLastError: null,
} as const;

/**
 * Links the creator's channel to a Discord server they just proved they manage. The CALLER has already checked
 * that `guildId` is in the creator's stashed candidate list; this re-checks bot presence, refuses a different
 * already-linked server, makes sure the server's Integrations plugin is on, and records who linked it.
 *
 * Integrations plugin: the chat bot only runs for a server-linked channel while that plugin is enabled in the server
 * (the Discord bridge and the Discord reward posts live in it too), and it is OFF by default. A streamer who links a
 * server would otherwise see their working chat bot silently stop, so linking turns the plugin on (through the normal
 * `GuildConfigStore.setEnabled`, which writes its own `plugin.enable` audit entry) when the linker — who has just
 * proved Manage Server there — did not have it on. Unlinking does NOT turn it back off (the server may use it).
 *
 * Idempotent per server: linking the SAME server again refreshes who/when and re-mirrors the child rows (this is also
 * what repairs a link whose child-row mirroring was interrupted). Not transactional — the channel row (the source
 * of truth) is written first, the mirrors after.
 */
export async function linkChannelToGuild(
  app: ZodFastifyInstance,
  input: { channel: TwitchChatChannel; guildId: string; discordUserId: string },
): Promise<TwitchChatChannel> {
  const { channel, guildId, discordUserId } = input;
  if (channel.guildId && channel.guildId !== guildId) throw alreadyLinkedElsewhereError();

  const guild = await app.prisma.guild.findUnique({ where: { id: guildId } });
  if (!guild || !guild.botPresent) throw new NotFoundError('Pavisie is not in this server.');

  let integrationsEnabledByLink = false;
  if (!(await app.configStore.isEnabled(guildId, TWITCH_CHAT_PLUGIN_ID))) {
    await app.configStore.setEnabled(guildId, TWITCH_CHAT_PLUGIN_ID, true, { id: discordUserId, source: 'dashboard' });
    integrationsEnabledByLink = true;
  }

  const alreadyLinked = channel.guildId === guildId;
  const updated = await app.prisma.twitchChatChannel.update({
    where: { id: channel.id },
    data: {
      guildId,
      discordLinkedBy: discordUserId,
      discordLinkedAt: new Date(),
      // A fresh link starts with the bridge off; re-linking the same server keeps whatever is configured.
      ...(alreadyLinked ? {} : NO_BRIDGE_DATA),
    },
  });

  // Commands/timers/rewards mirror their channel's guild (so the Discord dashboard lists them for the server).
  const mirror = { where: { channelId: channel.id }, data: { guildId } };
  await app.prisma.twitchChatCommand.updateMany(mirror);
  await app.prisma.twitchChatTimer.updateMany(mirror);
  await app.prisma.twitchChatReward.updateMany(mirror);

  await writeDashboardAudit(app.prisma, {
    guildId,
    actorId: discordUserId,
    action: 'integration.twitch_chat.discord.link',
    targetType: 'twitch_chat_channel',
    targetId: channel.id,
    after: {
      broadcasterLogin: channel.broadcasterLogin,
      linkedFrom: 'creator-dashboard',
      integrationsEnabledByLink,
    },
  });

  nudgeTwitchChatReconcile(app, guildId);
  return updated;
}

/**
 * Unlinks the Discord server from a channel (the channel and everything guild-independent stay: commands, timers,
 * currency, channel-point rewards, overlay). Used by the creator dashboard's Disconnect and by the Discord dashboard
 * when it is asked to remove a channel whose link the creator made themselves (the streamer's channel is not the
 * server admin's to delete). What happens, in an order that leaves the channel row — the marker — for last, so a
 * failed attempt can simply be retried:
 *
 * - the bridge webhook is deleted from Discord (best-effort) and the bridge is switched off and cleared;
 * - DISCORD-action rewards are DELETED, not disabled: their target is a channel id that only means something in the
 *   server just unlinked, and a leftover disabled reward the creator could neither edit nor use would be dead weight
 *   (a guildless channel is never allowed to hold one) — the creator recreates them after linking a server again;
 * - commands/timers/rewards drop their guild mirror (`guildId` null) so they no longer appear in that server's dashboard.
 *
 * The server's audit log gets an entry so its admins can see the link was removed, and by whom.
 */
export async function unlinkChannelFromGuild(
  app: ZodFastifyInstance,
  input: { channel: TwitchChatChannel; actor: { id: string; platform: 'twitch' | 'discord' } },
): Promise<{ deletedDiscordRewards: number }> {
  const { channel, actor } = input;
  const guildId = channel.guildId;
  if (!guildId) throw new NotFoundError('This channel is not connected to a Discord server.');

  if (channel.bridgeWebhookId && channel.bridgeWebhookTokenEnc) {
    await deleteBridgeWebhookBestEffort(channel.bridgeWebhookId, channel.bridgeWebhookTokenEnc);
  }

  const { count } = await app.prisma.twitchChatReward.deleteMany({
    where: { channelId: channel.id, action: 'DISCORD' },
  });

  const clear = { where: { channelId: channel.id }, data: { guildId: null } };
  await app.prisma.twitchChatCommand.updateMany(clear);
  await app.prisma.twitchChatTimer.updateMany(clear);
  await app.prisma.twitchChatReward.updateMany(clear);

  await app.prisma.twitchChatChannel.update({
    where: { id: channel.id },
    data: { guildId: null, discordLinkedBy: null, discordLinkedAt: null, ...NO_BRIDGE_DATA },
  });

  await writeDashboardAudit(app.prisma, {
    guildId,
    actorId: actor.platform === 'twitch' ? `twitch:${actor.id}` : actor.id,
    action: 'integration.twitch_chat.discord.unlink',
    targetType: 'twitch_chat_channel',
    targetId: channel.id,
    before: {
      broadcasterLogin: channel.broadcasterLogin,
      linkedBy: channel.discordLinkedBy,
      bridgeDiscordChannelId: channel.bridgeDiscordChannelId,
    },
    after: { unlinkedBy: actor.platform, deletedDiscordRewards: count },
  });

  nudgeTwitchChatReconcile(app, guildId);
  return { deletedDiscordRewards: count };
}
