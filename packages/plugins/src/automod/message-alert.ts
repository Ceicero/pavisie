// Caps staff alerts for message rules, so a burst of matches can't bury the alert channel.
//
// Every message rule with the "alert staff" action used to post one alert per matching message. A spam wave that
// matches 300 messages posted 300 embeds. Discord only lets a channel take a handful of messages every few seconds,
// so those queued for minutes behind each other and buried everything else in the channel.
//
// Now each rule gets `MESSAGE_ALERT_INDIVIDUAL_LIMIT` normal alerts (with their Confirm / False positive buttons)
// per channel the matches happen in, per `MESSAGE_ALERT_WINDOW_MS`. Past that, matches in that channel are counted
// into one summary alert ("+N more matches") instead, edited at most once every `MESSAGE_ALERT_UPDATE_INTERVAL_MS`
// and marked as ended once no match has spilled over for `MESSAGE_ALERT_QUIET_MS`. The summary has no review
// buttons because it stands for many events; every match is still saved as its own AutomodEvent, so staff review
// them one by one with `/automod review` or on the dashboard.
//
// The same shape as the raid alert (raid-alert.ts): state lives in Redis and updates run as queue jobs, so both
// survive a bot restart mid-burst. The summary never contains message text.
import { EmbedBuilder, type Guild } from 'discord.js';
import { BRAND, redisKey, truncate } from '@pavisie/core';
import { resolveTextChannel, type PluginContext, type PluginJob } from '../sdk';

/** How many normal alerts one rule may post for one channel's matches within `MESSAGE_ALERT_WINDOW_MS`. */
export const MESSAGE_ALERT_INDIVIDUAL_LIMIT = 5;
/** The window the individual-alert limit counts over. It starts at the first alert and resets when it runs out. */
export const MESSAGE_ALERT_WINDOW_MS = 60_000;
/** How often the summary alert may be edited while matches keep spilling over. */
export const MESSAGE_ALERT_UPDATE_INTERVAL_MS = 5_000;
/** A summary counts as ended once this long has passed without another match spilling over into it. */
export const MESSAGE_ALERT_QUIET_MS = 60_000;
/**
 * A stored summary whose last match is older than this is treated as abandoned (its update job was lost), and the
 * next overflow starts a fresh summary. Longer than quiet period + one update interval, so a healthy summary is
 * always closed by its own job first.
 */
const MESSAGE_ALERT_STALE_MS = MESSAGE_ALERT_QUIET_MS * 3;
/** Safety net only: Redis drops the summary state by itself if nothing ever closes it. */
const MESSAGE_ALERT_STATE_TTL_SECONDS = 60 * 60;

export const MESSAGE_ALERT_JOB_NAME = 'message-alert';
/** How many times one update is tried before it is given up on. */
export const MESSAGE_ALERT_JOB_ATTEMPTS = 5;

export interface MessageAlertJobData {
  guildId: string;
  ruleId: string;
  /** The channel the matches happened in (not the alert channel). */
  channelId: string;
  /** Identifies which summary this job belongs to; a job for an older summary does nothing. */
  startedAt: number;
  /** Only makes each job id unique. */
  tick: number;
}

/**
 * Atomically takes one individual-alert slot. Returns the number of alerts taken in the current window, counting
 * this one. Count and expiry are set in one step, so a crash can never leave a counter without its expiry.
 */
const TAKE_SLOT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1])) end
return n
`;

/**
 * Atomically adds one overflow match to the summary in progress, or starts a new one. Returns
 * `[startedNow, startedAt]`. The member is kept in a set so the summary can say how many people were involved.
 */
const RECORD_OVERFLOW_SCRIPT = `
local last = redis.call('HGET', KEYS[1], 'lastAt')
if last and (tonumber(ARGV[1]) - tonumber(last)) > tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1], KEYS[2])
end
local first = redis.call('HSETNX', KEYS[1], 'startedAt', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'matches', 1)
redis.call('HSET', KEYS[1], 'lastAt', ARGV[1])
redis.call('SADD', KEYS[2], ARGV[4])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return {first, redis.call('HGET', KEYS[1], 'startedAt')}
`;

/**
 * Atomically closes the summary if it is still the one the job was started for and it has gone quiet. Returns 1
 * when it closed it. Check and delete are one step, so a match that lands at the same moment either keeps this
 * summary open or starts cleanly after it.
 */
const CLOSE_IF_QUIET_SCRIPT = `
if redis.call('HGET', KEYS[1], 'startedAt') ~= ARGV[1] then return 0 end
local last = tonumber(redis.call('HGET', KEYS[1], 'lastAt') or '0')
if (tonumber(ARGV[2]) - last) < tonumber(ARGV[3]) then return 0 end
redis.call('DEL', KEYS[1], KEYS[2])
return 1
`;

function slotKey(guildId: string, ruleId: string, channelId: string): string {
  return redisKey('automod', 'msgalert', 'slots', guildId, ruleId, channelId);
}
function summaryKey(guildId: string, ruleId: string, channelId: string): string {
  return redisKey('automod', 'msgalert', 'summary', guildId, ruleId, channelId);
}
function membersKey(guildId: string, ruleId: string, channelId: string): string {
  return redisKey('automod', 'msgalert', 'members', guildId, ruleId, channelId);
}

/**
 * Whether this match may post a normal alert with review buttons. Takes one of the rule's individual-alert slots
 * for this channel; `false` means the slots are used up and the match belongs in the summary instead.
 */
export async function takeMessageAlertSlot(
  ctx: PluginContext,
  guildId: string,
  ruleId: string,
  channelId: string,
): Promise<boolean> {
  const taken = Number(
    await ctx.redis.eval(TAKE_SLOT_SCRIPT, 1, slotKey(guildId, ruleId, channelId), MESSAGE_ALERT_WINDOW_MS),
  );
  return taken <= MESSAGE_ALERT_INDIVIDUAL_LIMIT;
}

export interface MessageAlertSummaryView {
  ruleName: string;
  ruleType: string;
  /** The channel the matches happened in. */
  channelId: string;
  /** The rule's actions and what happened to them for the first match in the summary, already formatted. */
  actionsText: string;
  dryRun: boolean;
  matches: number;
  members: number;
  startedAt: number;
  lastAt: number;
  ended: boolean;
}

/** The summary alert embed, in its "in progress" or "ended" form. Pure, so the wording is unit-tested. */
export function messageAlertSummaryEmbed(view: MessageAlertSummaryView): EmbedBuilder {
  const seconds = (ms: number): number => Math.floor(ms / 1000);
  const status = view.ended
    ? `Ended <t:${seconds(view.lastAt)}:R>. No further match for ${MESSAGE_ALERT_QUIET_MS / 1000} seconds.`
    : `In progress. This message updates every ${MESSAGE_ALERT_UPDATE_INTERVAL_MS / 1000} seconds.`;

  return (
    new EmbedBuilder()
      // Same colours as every other automod alert: neutral for dry-run, red for a live trigger.
      .setColor(view.dryRun ? BRAND.color : 0xef4444)
      .setTitle(
        truncate(
          `${view.dryRun ? '[DRY RUN] ' : ''}Automod: ${view.ruleName} — +${view.matches} more${view.ended ? ' (ended)' : ''}`,
          256,
        ),
      )
      .setDescription(
        `This rule already posted ${MESSAGE_ALERT_INDIVIDUAL_LIMIT} alerts for this channel in the last minute. ` +
          'Further matches are counted here instead of posting one alert each.',
      )
      .addFields(
        { name: 'More matches', value: `+${view.matches}`, inline: true },
        { name: 'Members', value: String(view.members), inline: true },
        { name: 'Channel', value: `<#${view.channelId}>`, inline: true },
        { name: 'Rule type', value: view.ruleType, inline: true },
        { name: 'Started', value: `<t:${seconds(view.startedAt)}:R>`, inline: true },
        { name: 'Status', value: status },
        { name: 'Actions', value: view.actionsText },
        {
          name: 'Review',
          value:
            'No buttons here because this alert covers many matches. Each match is saved on its own: use `/automod review` or the dashboard to go through them.',
        },
      )
      .setTimestamp(view.ended ? view.lastAt : view.startedAt)
  );
}

async function scheduleUpdate(ctx: PluginContext, data: MessageAlertJobData): Promise<void> {
  await ctx.queue(MESSAGE_ALERT_JOB_NAME).add(MESSAGE_ALERT_JOB_NAME, data, {
    // `-` separators: BullMQ rejects most custom job ids containing `:` (see moderation's expiry job).
    jobId: `msgalert-${data.guildId}-${data.ruleId}-${data.channelId}-${data.startedAt}-${data.tick}`,
    delay: MESSAGE_ALERT_UPDATE_INTERVAL_MS,
    // Each update queues the next one, so one that fails outright would end the chain and freeze the summary.
    // Retried instead; the processor is safe to run twice.
    attempts: MESSAGE_ALERT_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  });
}

/**
 * Records one match that has no individual-alert slot left. The first one posts the summary alert and starts its
 * update job; every later one is a single Redis call and nothing else.
 */
export async function recordMessageAlertOverflow(
  ctx: PluginContext,
  guild: Guild,
  params: {
    ruleId: string;
    ruleName: string;
    ruleType: string;
    /** The channel the match happened in. */
    channelId: string;
    userId: string;
    alertChannelId: string;
    actionsText: string;
    dryRun: boolean;
  },
): Promise<void> {
  const key = summaryKey(guild.id, params.ruleId, params.channelId);
  const now = Date.now();
  const [startedNow, startedAtRaw] = (await ctx.redis.eval(
    RECORD_OVERFLOW_SCRIPT,
    2,
    key,
    membersKey(guild.id, params.ruleId, params.channelId),
    now,
    MESSAGE_ALERT_STALE_MS,
    MESSAGE_ALERT_STATE_TTL_SECONDS,
    params.userId,
  )) as [number, string];
  if (startedNow !== 1) return;

  const startedAt = Number(startedAtRaw);
  await ctx.redis.hset(key, {
    ruleName: params.ruleName,
    ruleType: params.ruleType,
    actionsText: params.actionsText,
    dryRun: params.dryRun ? '1' : '0',
  });

  // Scheduled before the post is attempted, so the summary is still closed out (and its state removed) even when
  // the alert itself cannot be posted.
  await scheduleUpdate(ctx, {
    guildId: guild.id,
    ruleId: params.ruleId,
    channelId: params.channelId,
    startedAt,
    tick: 1,
  }).catch((err: unknown) => {
    ctx.logger.error(
      { guildId: guild.id, ruleId: params.ruleId, err: err instanceof Error ? err.message : String(err) },
      'automod: failed to schedule message alert summary updates; the summary will not show a running count',
    );
  });

  const channel = await resolveTextChannel(guild, params.alertChannelId);
  if (!channel) {
    ctx.logger.warn(
      { guildId: guild.id, channelId: params.alertChannelId },
      'automod: cannot post to configured alert channel (missing/no permission)',
    );
    return;
  }

  try {
    const message = await channel.send({
      embeds: [
        messageAlertSummaryEmbed({
          ruleName: params.ruleName,
          ruleType: params.ruleType,
          channelId: params.channelId,
          actionsText: params.actionsText,
          dryRun: params.dryRun,
          matches: 1,
          members: 1,
          startedAt,
          lastAt: startedAt,
          ended: false,
        }),
      ],
      allowedMentions: { parse: [] },
    });
    // Only if this summary is still the current one: a slow post must not attach its message to a later summary.
    if ((await ctx.redis.hget(key, 'startedAt')) === startedAtRaw) {
      await ctx.redis.hset(key, { messageId: message.id, alertChannelId: channel.id, shown: '1:1' });
    }
  } catch (err) {
    ctx.logger.error(
      { guildId: guild.id, err: err instanceof Error ? err.message : String(err) },
      'automod: failed to post message alert summary',
    );
  }
}

/**
 * The update job: edits the summary when its counts have changed, and closes it out once it has gone quiet.
 * Re-queues itself while matches keep coming, so there is never more than one edit per update interval.
 */
export const messageAlertJob: PluginJob<MessageAlertJobData> = {
  name: MESSAGE_ALERT_JOB_NAME,
  concurrency: 5,
  async processor(ctx, job) {
    const { guildId, ruleId, channelId, startedAt, tick } = job.data;
    const key = summaryKey(guildId, ruleId, channelId);
    const memberSet = membersKey(guildId, ruleId, channelId);
    const state = await ctx.redis.hgetall(key);
    // Gone (closed, expired) or replaced by a newer summary: this job has nothing left to do.
    if (Number(state.startedAt) !== startedAt) return;
    // Read before the close below, which deletes the set along with the summary.
    const members = await ctx.redis.scard(memberSet);

    const now = Date.now();
    const closed =
      (await ctx.redis.eval(
        CLOSE_IF_QUIET_SCRIPT,
        2,
        key,
        memberSet,
        String(startedAt),
        now,
        MESSAGE_ALERT_QUIET_MS,
      )) === 1;

    const matches = Number(state.matches ?? 0);
    const lastAt = Number(state.lastAt ?? startedAt);
    const shown = `${matches}:${members}`;
    if (state.messageId && state.alertChannelId && (closed || shown !== state.shown)) {
      try {
        const guild =
          ctx.client.guilds.cache.get(guildId) ?? (await ctx.client.guilds.fetch(guildId).catch(() => null));
        const channel = guild ? await resolveTextChannel(guild, state.alertChannelId) : null;
        if (!channel) throw new Error('alert channel is no longer available');
        await channel.messages.edit(state.messageId, {
          embeds: [
            messageAlertSummaryEmbed({
              ruleName: state.ruleName ?? 'Automod rule',
              ruleType: state.ruleType ?? 'UNKNOWN',
              channelId,
              actionsText: state.actionsText ?? '_None configured_',
              dryRun: state.dryRun === '1',
              matches,
              members,
              startedAt,
              lastAt,
              ended: closed,
            }),
          ],
          allowedMentions: { parse: [] },
        });
        if (!closed) await ctx.redis.hset(key, 'shown', shown);
      } catch (err) {
        // A deleted alert or a lost permission must not stop the summary from being tracked and closed out.
        ctx.logger.warn(
          { guildId, ruleId, err: err instanceof Error ? err.message : String(err) },
          'automod: failed to update message alert summary',
        );
      }
    }

    if (!closed) await scheduleUpdate(ctx, { guildId, ruleId, channelId, startedAt, tick: tick + 1 });
  },
};
