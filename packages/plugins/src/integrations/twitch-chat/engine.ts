// Twitch chat command engine — pure/testable: no `PluginContext`, no Prisma, no network. `TwitchChatManager`
// feeds it a channel snapshot + its cached commands on every incoming `channel.chat.message` notification, and
// injects tiny `helix`-shaped callbacks for the two built-ins that need a Helix call. NEVER log or persist
// `messageText`/chatter identity here — this module only returns a reply string (or `null`) to send back.
import type { TwitchChatLevel } from '@pavisie/database';

export interface EngineCommand {
  name: string;
  response: string;
  cooldownSeconds: number;
  minLevel: TwitchChatLevel;
  enabled: boolean;
}

export interface EngineChannel {
  id: string;
  commandPrefix: string;
  broadcasterLogin: string;
  broadcasterUserId: string;
}

/** One incoming `channel.chat.message` EventSub event, reduced to exactly what the engine needs. */
export interface ChatMessageEvent {
  chatterUserId: string;
  /** Chatter's display name — used only for `{user}` templating, never logged. */
  chatterDisplayName: string;
  messageText: string;
  /** Badge `set_id`s present on the chatter for this message (e.g. `['broadcaster']`, `['subscriber', 'vip']`). */
  badgeSetIds: string[];
}

/** A Helix lookup either produced a real answer (`ok: true`, possibly `null` meaning "no data" — e.g. offline)
 * or failed outright (`ok: false`) — the engine must never conflate the two, since reporting "offline"/"no title
 * set" for what was actually a Helix error tells chat something false. */
export type EngineHelixResult<T> = { ok: true; value: T } | { ok: false };

export interface EngineHelix {
  getStream(broadcasterUserId: string): Promise<EngineHelixResult<{ startedAt: string } | null>>;
  getChannelInfo(broadcasterUserId: string): Promise<EngineHelixResult<{ title: string | null } | null>>;
}

/** Cooldown key prefix + shared duration for the three built-ins (`!commands`/`!uptime`/`!title`) — they aren't
 * `TwitchChatCommand` rows, so they have no per-command `cooldownSeconds` of their own; this is a fixed, cheap
 * anti-spam gate rather than a configurable feature. */
const BUILTIN_COOLDOWN_SECONDS = 5;
function builtinCooldownKey(name: string): string {
  return `__builtin:${name}`;
}

/** Per-`(channelId, commandName)` cooldown gate, in-memory. One instance is meant to live for the lifetime of
 * the `TwitchChatManager` singleton (not per-message) so cooldowns actually persist between messages; tests
 * construct a fresh instance per test instead of resetting global state. */
export class CommandCooldowns {
  private readonly lastUsedAtMs = new Map<string, number>();

  /** Returns `true` (and starts the cooldown) if `(channelId, commandName)` is currently off cooldown. */
  take(channelId: string, commandName: string, cooldownSeconds: number, now = Date.now()): boolean {
    const key = `${channelId}:${commandName}`;
    const last = this.lastUsedAtMs.get(key) ?? 0;
    if (now - last < cooldownSeconds * 1000) return false;
    this.lastUsedAtMs.set(key, now);
    return true;
  }

  /** Drops every cooldown entry for `channelId` (both custom commands and `__builtin:*` entries) — called by
   * `TwitchChatManager` whenever it stops tracking a channel (unsubscribed, revoked, or a whole-session reset),
   * so this map doesn't accumulate stale entries for channels that are no longer connected. */
  pruneChannel(channelId: string): void {
    const prefix = `${channelId}:`;
    for (const key of this.lastUsedAtMs.keys()) {
      if (key.startsWith(prefix)) this.lastUsedAtMs.delete(key);
    }
  }
}

const LEVEL_ORDER: Record<TwitchChatLevel, number> = {
  EVERYONE: 0,
  SUBSCRIBER: 1,
  VIP: 2,
  MODERATOR: 3,
  BROADCASTER: 4,
};

const BADGE_TO_LEVEL: Record<string, TwitchChatLevel> = {
  subscriber: 'SUBSCRIBER',
  founder: 'SUBSCRIBER', // founders are a permanent-subscriber badge variant
  vip: 'VIP',
  moderator: 'MODERATOR',
  broadcaster: 'BROADCASTER',
};

/** Highest chat-privilege level implied by a chatter's badge set (unknown/absent badges → `EVERYONE`). */
export function resolveChatterLevel(badgeSetIds: string[]): TwitchChatLevel {
  let best: TwitchChatLevel = 'EVERYONE';
  for (const setId of badgeSetIds) {
    const level = BADGE_TO_LEVEL[setId];
    if (level && LEVEL_ORDER[level] > LEVEL_ORDER[best]) best = level;
  }
  return best;
}

/** Fills `{user}`/`{channel}` placeholders only — no other interpolation, per spec. */
export function applyTemplate(template: string, vars: { user: string; channel: string }): string {
  return template.replace(/\{user\}|\{channel\}/g, (match) => (match === '{user}' ? vars.user : vars.channel));
}

function formatUptime(startedAtIso: string, now = Date.now()): string {
  const totalMinutes = Math.max(0, Math.floor((now - new Date(startedAtIso).getTime()) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export interface HandleChatMessageInput {
  /** The bot identity's own Twitch user id — messages from this id are always ignored (self-ignore). */
  botUserId: string;
  channel: EngineChannel;
  /** Enabled custom commands for this channel (reserved built-in names never appear here — enforced at write time). */
  commands: EngineCommand[];
  event: ChatMessageEvent;
  cooldowns: CommandCooldowns;
  helix: EngineHelix;
  now?: number;
}

/**
 * Parses one chat message against `channel`'s prefix/commands and returns the reply to send, or `null` if
 * nothing should be sent (not a command, unknown command, below the required level, on cooldown, or the
 * message is from the bot itself).
 */
export async function handleChatMessage(input: HandleChatMessageInput): Promise<string | null> {
  const { botUserId, channel, commands, event, cooldowns, helix, now = Date.now() } = input;

  if (event.chatterUserId === botUserId) return null;

  const prefix = channel.commandPrefix;
  if (!prefix || !event.messageText.startsWith(prefix)) return null;

  const rest = event.messageText.slice(prefix.length).trim();
  if (!rest) return null;
  // Custom commands take no arguments in v1 — only the first whitespace-separated token is ever read.
  const name = (rest.split(/\s+/)[0] ?? '').toLowerCase();
  if (!name) return null;

  if (name === 'commands') {
    if (!cooldowns.take(channel.id, builtinCooldownKey('commands'), BUILTIN_COOLDOWN_SECONDS, now)) return null;
    const names = commands
      .filter((c) => c.enabled)
      .map((c) => c.name)
      .sort();
    return names.length > 0
      ? `Commands: ${names.map((n) => `${prefix}${n}`).join(', ')}`
      : 'No custom commands are set up for this channel.';
  }

  if (name === 'uptime') {
    if (!cooldowns.take(channel.id, builtinCooldownKey('uptime'), BUILTIN_COOLDOWN_SECONDS, now)) return null;
    const result = await helix.getStream(channel.broadcasterUserId);
    // A failed Helix lookup is not the same as "confirmed offline" — say nothing rather than assert something
    // that might be false.
    if (!result.ok) return null;
    const stream = result.value;
    return stream
      ? `${channel.broadcasterLogin} has been live for ${formatUptime(stream.startedAt, now)}.`
      : `${channel.broadcasterLogin} is offline.`;
  }

  if (name === 'title') {
    if (!cooldowns.take(channel.id, builtinCooldownKey('title'), BUILTIN_COOLDOWN_SECONDS, now)) return null;
    const result = await helix.getChannelInfo(channel.broadcasterUserId);
    if (!result.ok) return null;
    const info = result.value;
    return info?.title ? `Title: ${info.title}` : 'No title is set.';
  }

  const command = commands.find((c) => c.enabled && c.name === name);
  if (!command) return null;

  const chatterLevel = resolveChatterLevel(event.badgeSetIds);
  if (LEVEL_ORDER[chatterLevel] < LEVEL_ORDER[command.minLevel]) return null;

  if (!cooldowns.take(channel.id, command.name, command.cooldownSeconds, now)) return null;

  return applyTemplate(command.response, { user: event.chatterDisplayName, channel: channel.broadcasterLogin });
}
