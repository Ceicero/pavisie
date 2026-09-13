// Twitch channel-point reward matching — pure/testable: no `PluginContext`, no Prisma, no network (mirrors
// `engine.ts`'s own pure-module discipline for chat commands). `TwitchChatManager` feeds this a redemption
// event plus the channel's cached `TwitchChatReward` rows on every incoming
// `channel.channel_points_custom_reward_redemption.add` notification, and runs whatever action list comes back.
//
// PRIVACY: this module NEVER logs or persists `event.userInput`/`event.userDisplayName` — same stance as
// `engine.ts`'s chat-message handling (no message content logged unless a feature needs it and an admin turns
// it on). It has no logger dependency at all, so there is nothing here that could leak them; the caller
// (`manager.ts`) must keep the same discipline when it logs about a dispatched action (reward title + action
// kind only, never the templated text or the redeemer's name).
import type { TwitchChatReward } from '@pavisie/database';

/** One incoming `channel.channel_points_custom_reward_redemption.add` v1 notification, reduced to exactly what
 * this module needs (field names translated from Twitch's own snake_case payload by the caller). */
export interface RewardRedemptionEvent {
  rewardId: string;
  rewardTitle: string;
  /** Viewer-supplied text for a reward that requires input (e.g. spoken via TTS) — NEVER logged. */
  userInput: string;
  /** Redeeming viewer's display name — used only for `{user}` templating, NEVER logged. */
  userDisplayName: string;
}

export type RewardAction =
  | { kind: 'SOUND'; reward: TwitchChatReward; soundUrl: string; volume: number }
  | { kind: 'TTS'; reward: TwitchChatReward; text: string; volume: number }
  | { kind: 'CHAT'; reward: TwitchChatReward; text: string }
  | { kind: 'DISCORD'; reward: TwitchChatReward; discordChannelId: string; text: string };

/** TTS text is spoken aloud on the streamer's overlay — kept short. Chat/Discord text is merely posted, so it
 * gets a slightly longer cap. Both caps apply AFTER templating, so an oversized `{input}` can't smuggle a
 * too-long final string past the limit. */
const TTS_MAX_CHARS = 200;
const TEXT_MAX_CHARS = 300;

// eslint-disable-next-line no-control-regex -- intentionally stripping control characters before any templated text is emitted (mirrors sanitizeFilename's own control-char strip in @pavisie/core)
const CONTROL_CHARS_PATTERN = /[\x00-\x1F\x7F]/g;

/** Safety gate applied to every templated string right before it's queued to be spoken/posted/published: strips
 * control characters, collapses runs of whitespace to a single space, trims, and caps length. */
export function sanitizeRewardText(input: string, maxChars: number): string {
  const cleaned = input.replace(CONTROL_CHARS_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

/** Fills `{user}`, `{input}`, `{reward}` placeholders only — no other interpolation, per spec. */
export function applyRewardTemplate(template: string, vars: { user: string; input: string; reward: string }): string {
  return template.replace(/\{user\}|\{input\}|\{reward\}/g, (match) => {
    if (match === '{user}') return vars.user;
    if (match === '{input}') return vars.input;
    return vars.reward;
  });
}

/**
 * Per-`(channelId, rewardRowId)` cooldown gate, in-memory — same shape as `engine.ts`'s `CommandCooldowns`, kept
 * as a separate class since reward cooldowns are keyed by reward ROW id (one redemption can match several rows —
 * a broadcaster may configure both a SOUND and a DISCORD action for the same reward title — each with its own
 * independent `cooldownSeconds`), not by command name. One instance is meant to live for the lifetime of the
 * `TwitchChatManager` singleton; `pruneChannel` is called from `forgetChannel`/`forgetSubscription` so this map
 * doesn't accumulate stale entries for channels no longer tracked.
 */
export class RewardCooldowns {
  private readonly lastUsedAtMs = new Map<string, number>();

  /** Returns `true` (and starts the cooldown) if `(channelId, rewardRowId)` is currently off cooldown. A
   * `cooldownSeconds` of 0 (the default) always passes. */
  take(channelId: string, rewardRowId: string, cooldownSeconds: number, now = Date.now()): boolean {
    if (cooldownSeconds <= 0) return true;
    const key = `${channelId}:${rewardRowId}`;
    const last = this.lastUsedAtMs.get(key);
    if (last !== undefined && now - last < cooldownSeconds * 1000) return false;
    this.lastUsedAtMs.set(key, now);
    return true;
  }

  /** Drops every cooldown entry for `channelId` — called whenever the manager stops tracking that channel's
   * rewards subscription (removed, disabled, revoked, or a whole-session reset). */
  pruneChannel(channelId: string): void {
    const prefix = `${channelId}:`;
    for (const key of this.lastUsedAtMs.keys()) {
      if (key.startsWith(prefix)) this.lastUsedAtMs.delete(key);
    }
  }
}

/** Matches a redemption event to one configured reward row: by `rewardId` when the row has one (picked from the
 * dashboard's "list rewards from Twitch" dropdown), else by case-insensitive `rewardTitle` (for a row created
 * before the matching Twitch reward existed, or configured by hand). */
function matchesReward(row: TwitchChatReward, event: RewardRedemptionEvent): boolean {
  if (row.rewardId) return row.rewardId === event.rewardId;
  return row.rewardTitle.toLowerCase() === event.rewardTitle.toLowerCase();
}

/** Builds the action for one matched, non-disabled, off-cooldown reward row — `null` when the row is missing the
 * payload field its own `action` kind requires (write-time validation should prevent this, but a defensive
 * check here means a malformed row is silently skipped rather than dispatched with `undefined` fields) or when
 * the safety-gated text ends up empty (e.g. a template that resolves to nothing but whitespace/control chars). */
function buildAction(row: TwitchChatReward, event: RewardRedemptionEvent): RewardAction | null {
  const templateVars = { user: event.userDisplayName, input: event.userInput, reward: row.rewardTitle };

  switch (row.action) {
    case 'SOUND': {
      if (!row.soundUrl) return null;
      return { kind: 'SOUND', reward: row, soundUrl: row.soundUrl, volume: row.volume };
    }
    case 'TTS': {
      if (!row.ttsTemplate) return null;
      const text = sanitizeRewardText(applyRewardTemplate(row.ttsTemplate, templateVars), TTS_MAX_CHARS);
      if (!text) return null;
      return { kind: 'TTS', reward: row, text, volume: row.volume };
    }
    case 'CHAT': {
      if (!row.chatTemplate) return null;
      const text = sanitizeRewardText(applyRewardTemplate(row.chatTemplate, templateVars), TEXT_MAX_CHARS);
      if (!text) return null;
      return { kind: 'CHAT', reward: row, text };
    }
    case 'DISCORD': {
      if (!row.discordChannelId || !row.discordTemplate) return null;
      const text = sanitizeRewardText(applyRewardTemplate(row.discordTemplate, templateVars), TEXT_MAX_CHARS);
      if (!text) return null;
      return { kind: 'DISCORD', reward: row, discordChannelId: row.discordChannelId, text };
    }
    default:
      return null;
  }
}

/**
 * Matches an incoming redemption event against `rewards` (the channel's cached `TwitchChatReward` rows — the
 * caller, `TwitchChatManager`, is responsible for scoping this to one channel), applies the per-row cooldown
 * gate, templates `{user}`/`{input}`/`{reward}`, and runs the safety gate (control-char strip, whitespace
 * collapse, length cap) — returning the list of actions to actually run this redemption. A row that's disabled,
 * doesn't match, is on cooldown, or resolves to no usable action contributes nothing. Multiple rows CAN match
 * the same redemption (one per configured `action` kind, per the `@@unique([channelId, rewardTitle, action])`
 * constraint), so the result may contain more than one action for a single redemption.
 */
export function matchRewardActions(
  channelId: string,
  rewards: TwitchChatReward[],
  event: RewardRedemptionEvent,
  cooldowns: RewardCooldowns,
  now = Date.now(),
): RewardAction[] {
  const actions: RewardAction[] = [];
  for (const row of rewards) {
    if (!row.enabled) continue;
    if (!matchesReward(row, event)) continue;
    const action = buildAction(row, event);
    if (!action) continue;
    if (!cooldowns.take(channelId, row.id, row.cooldownSeconds, now)) continue;
    actions.push(action);
  }
  return actions;
}
