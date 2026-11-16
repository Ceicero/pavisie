// Tells every bot process that a guild's automod rules changed, so none of them keeps evaluating a cached copy.
//
// The bot caches each guild's rules for a couple of seconds (see `loadRules` in service.ts). A rule edited in
// the dashboard is written by the API process, which cannot reach that in-memory cache — so without a signal an
// edit (including disabling or deleting a rule) only took effect once the cached copy expired. The API now
// publishes one small message on a Redis channel after every rule write, and the bot drops its cached copy the
// moment it arrives.
//
// Redis pub/sub is fire-and-forget: a message published while a bot's subscriber is reconnecting is lost. That is
// why the cache keeps its short expiry — the signal makes edits immediate, the expiry bounds the worst case.
//
// Deliberately free of discord.js and of the rest of the plugin, so the API can import it on its own
// (`@pavisie/plugins/automod/rule-sync`).
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { redisKey } from '@pavisie/core';

export const AUTOMOD_RULES_CHANGED_CHANNEL = redisKey('automod', 'rules-changed');

/** Identifies this process, so a bot that announces its own change does not then act on its own announcement. */
const PROCESS_ID = randomUUID();

interface RulesChangedMessage {
  guildId: string;
  origin: string;
}

/**
 * Announces that `guildId`'s rules changed. Never throws: the write it follows has already been committed, and a
 * lost announcement only means the change waits for the cache to expire. Returns whether it was published.
 */
export async function publishAutomodRulesChanged(redis: Redis, guildId: string): Promise<boolean> {
  try {
    const message: RulesChangedMessage = { guildId, origin: PROCESS_ID };
    await redis.publish(AUTOMOD_RULES_CHANGED_CHANNEL, JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

/** Reads a channel message, returning the guild id it names — or null for anything malformed or self-sent. */
export function parseRulesChangedMessage(raw: string, ownOrigin: string = PROCESS_ID): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { guildId, origin } = parsed as Partial<RulesChangedMessage>;
  if (typeof guildId !== 'string' || guildId.length === 0 || guildId.length > 64) return null;
  if (origin === ownOrigin) return null;
  return guildId;
}

export interface RulesChangedSubscription {
  close(): Promise<void>;
}

/**
 * Calls `onChange(guildId)` whenever another process announces a rule change. Uses its own connection
 * (`redis.duplicate()`): a Redis connection in subscriber mode cannot run ordinary commands, so it must not be
 * the shared one. ioredis re-subscribes by itself after a reconnect.
 */
export async function subscribeAutomodRulesChanged(
  redis: Redis,
  onChange: (guildId: string) => void,
): Promise<RulesChangedSubscription> {
  const subscriber = redis.duplicate();
  subscriber.on('message', (channel: string, raw: string) => {
    if (channel !== AUTOMOD_RULES_CHANGED_CHANNEL) return;
    const guildId = parseRulesChangedMessage(raw);
    if (guildId) onChange(guildId);
  });
  // Without a listener, a connection error on this dedicated client would be an unhandled 'error' event.
  subscriber.on('error', () => undefined);
  await subscriber.subscribe(AUTOMOD_RULES_CHANGED_CHANNEL);
  return {
    async close() {
      await subscriber.quit().catch(() => undefined);
    },
  };
}
