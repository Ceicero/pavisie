// Pure helpers shared by the bot-side sticky service (`./sticky.ts`) and the API (`apps/api/src/routes/community.ts`),
// which must invalidate the same Redis cache when a sticky is deleted from the dashboard. Kept free of discord.js
// so the API can import it cheaply.
import { redisKey } from '@pavisie/core';

/** Seconds the per-guild "channels that have a sticky" set stays cached in Redis. */
export const STICKY_CHANNELS_TTL_SECONDS = 300;

/** Seconds the per-channel repost lock is held (`SET NX EX`) around delete+send+DB-update — generous relative to
 * how long that sequence actually takes, so a crashed process can't wedge a channel's sticky forever. */
export const STICKY_REPOST_LOCK_TTL_SECONDS = 15;

/** Seconds a repost's own posted message id is remembered so the auto-publish handler can recognise and skip it. */
export const STICKY_OWN_MESSAGE_TTL_SECONDS = 600;

/** Seconds between repeated "sticky failed to send" logs for the same channel (mirrors channel-automations.ts's `WARN_TTL_SECONDS`). */
export const STICKY_SEND_WARN_TTL_SECONDS = 3600;

/** Redis key holding a JSON array of channel ids that have a sticky in `guildId` (lazily filled, DEL'd on every write). */
export function stickyChannelsKey(guildId: string): string {
  return redisKey('community', 'sticky-channels', guildId);
}

/** Redis key for the per-channel re-post cooldown (`SET NX EX <cooldownSeconds>`). */
export function stickyCooldownKey(guildId: string, channelId: string): string {
  return redisKey('community', 'sticky-cd', guildId, channelId);
}

/** Redis key for the per-channel repost lock that serializes `repostSticky` so a catch-up job and a
 * cooldown-triggered repost can never both delete+send+update at once (which orphans a duplicate copy). */
export function stickyRepostLockKey(guildId: string, channelId: string): string {
  return redisKey('community', 'sticky-repost-lock', guildId, channelId);
}

/** Redis key marking `messageId` as the bot's own sticky repost, so `channelAutomationsHandler` can skip
 * crossposting it even in a channel that also has auto-publish enabled. */
export function stickyOwnMessageKey(messageId: string): string {
  return redisKey('community', 'sticky-own', messageId);
}

/** Redis key guarding "sticky failed to send" log spam to once per channel per hour. */
export function stickySendWarnedKey(guildId: string, channelId: string): string {
  return redisKey('community', 'sticky-send-warned', guildId, channelId);
}

/** BullMQ jobId for the single debounced catch-up re-post per channel. Dash-separated for consistency with the
 * rest of the community/roles plugins' custom job ids (see `birthdayRoleRemoveJobId` for why `:` is avoided). */
export function stickyRepostJobId(guildId: string, channelId: string): string {
  return `sticky-${guildId}-${channelId}`;
}

/** The sticky's optional embed — the same flat shape as `/embed builder`'s `EmbedBuilderPayload`. */
export interface StickyEmbed {
  title?: string;
  description?: string;
  colorHex?: string;
  imageUrl?: string;
  footer?: string;
}

/** Normalises the `StickyMessage.embed` Json column into a `StickyEmbed`, dropping anything that isn't a string field. */
export function parseStickyEmbed(raw: unknown): StickyEmbed | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const pick = (key: keyof StickyEmbed): string | undefined =>
    typeof obj[key] === 'string' && (obj[key] as string).trim() ? (obj[key] as string) : undefined;
  const embed: StickyEmbed = {
    title: pick('title'),
    description: pick('description'),
    colorHex: pick('colorHex'),
    imageUrl: pick('imageUrl'),
    footer: pick('footer'),
  };
  return isStickyEmbedEmpty(embed) ? null : embed;
}

/** True when the embed has nothing visible to render (a bare color is not enough). */
export function isStickyEmbedEmpty(embed: StickyEmbed | null | undefined): boolean {
  if (!embed) return true;
  return !embed.title && !embed.description && !embed.imageUrl && !embed.footer;
}

/** Short one-line preview of a sticky for lists (bot `/sticky list` and the dashboard table). */
export function stickyPreview(sticky: { content: string | null; embed: unknown }, maxChars = 40): string {
  const embed = parseStickyEmbed(sticky.embed);
  const source = sticky.content?.trim() || embed?.title || embed?.description || '';
  const oneLine = source.replace(/\s+/g, ' ').trim();
  if (!oneLine) return embed?.imageUrl ? '(image embed)' : '(empty)';
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}…` : oneLine;
}
