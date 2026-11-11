// One staff alert per raid, edited in place — instead of one alert message per joining account.
//
// A RAID_DETECTION rule keeps matching for every join once the burst threshold is passed, so a 750-account raid
// used to post ~740 alert embeds. Discord only lets a channel take a handful of messages every few seconds, so
// those queued for minutes behind each other, long after the raid was over, and buried the channel.
//
// Now the first flagged join of a raid posts one alert. Every later flagged join only bumps a counter in Redis
// (no Discord call at all). A background job edits that one message with the running count at most once every
// `RAID_ALERT_UPDATE_INTERVAL_MS`, and once no flagged join has arrived for `RAID_ALERT_QUIET_MS` it makes a final
// edit marking the raid as ended. Whatever the size of the raid, the alert channel sees one message and at most
// one edit per interval — well inside Discord's per-channel limits.
//
// The state lives in Redis and the updates run as queue jobs, so both survive a bot restart mid-raid.
import { EmbedBuilder, type Guild } from 'discord.js';
import { BRAND, redisKey, truncate } from '@pavisie/core';
import { resolveTextChannel, type PluginContext, type PluginJob } from '../sdk';

/** How often the raid alert may be edited while a raid is in progress. */
export const RAID_ALERT_UPDATE_INTERVAL_MS = 5_000;
/** A raid counts as over once this long has passed without another flagged join. */
export const RAID_ALERT_QUIET_MS = 60_000;
/**
 * A stored raid whose last flagged join is older than this is treated as abandoned (its update job was lost),
 * and the next flagged join starts a fresh alert. Comfortably longer than quiet period + one update interval, so
 * a healthy raid is always closed by its own job first and never mistaken for an abandoned one.
 */
const RAID_ALERT_STALE_MS = RAID_ALERT_QUIET_MS * 3;
/** Safety net only: Redis drops the state by itself if nothing ever closes the raid. */
const RAID_ALERT_STATE_TTL_SECONDS = 60 * 60;

export const RAID_ALERT_JOB_NAME = 'raid-alert';

export interface RaidAlertJobData {
  guildId: string;
  ruleId: string;
  /** Identifies which raid this job belongs to; a job for an older raid of the same rule does nothing. */
  startedAt: number;
  /** Only makes each job id unique. */
  tick: number;
}

/** Atomically joins the raid in progress for this rule, or starts a new one. Returns `[startedNow, startedAt]`. */
const RECORD_JOIN_SCRIPT = `
local last = redis.call('HGET', KEYS[1], 'lastJoinAt')
if last and (tonumber(ARGV[1]) - tonumber(last)) > tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
end
local first = redis.call('HSETNX', KEYS[1], 'startedAt', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'joins', 1)
redis.call('HSET', KEYS[1], 'lastJoinAt', ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return {first, redis.call('HGET', KEYS[1], 'startedAt')}
`;

/**
 * Atomically closes the raid if it is still the one the job was started for and it has gone quiet. Returns 1
 * when it closed it. Check and delete are one step so a join that lands at the same moment either keeps this
 * raid open or starts cleanly after it — it can never be counted into state that is being deleted.
 */
const CLOSE_IF_QUIET_SCRIPT = `
if redis.call('HGET', KEYS[1], 'startedAt') ~= ARGV[1] then return 0 end
local last = tonumber(redis.call('HGET', KEYS[1], 'lastJoinAt') or '0')
if (tonumber(ARGV[2]) - last) < tonumber(ARGV[3]) then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

function stateKey(guildId: string, ruleId: string): string {
  return redisKey('automod', 'raidalert', guildId, ruleId);
}

export interface RaidAlertView {
  ruleName: string;
  reason: string;
  /** The rule's actions and what happened to them for the first flagged join, already formatted. */
  actionsText: string;
  dryRun: boolean;
  joins: number;
  startedAt: number;
  lastJoinAt: number;
  ended: boolean;
}

/** The single raid alert embed, in its "in progress" or "ended" form. Pure, so the wording is unit-tested. */
export function raidAlertEmbed(view: RaidAlertView): EmbedBuilder {
  const seconds = (ms: number): number => Math.floor(ms / 1000);
  const status = view.ended
    ? `Raid ended <t:${seconds(view.lastJoinAt)}:R>. No flagged join for ${RAID_ALERT_QUIET_MS / 1000} seconds.`
    : `In progress. This message updates every ${RAID_ALERT_UPDATE_INTERVAL_MS / 1000} seconds; no further alerts are posted for this raid.`;

  return (
    new EmbedBuilder()
      // Same colours as every other automod alert: neutral for dry-run, red for a live trigger.
      .setColor(view.dryRun ? BRAND.color : 0xef4444)
      .setTitle(
        `${view.dryRun ? '[DRY RUN] ' : ''}Automod: ${view.ruleName}${view.ended ? ' (raid ended)' : ''}`,
      )
      .setDescription(truncate(view.reason, 2000))
      .addFields(
        { name: 'Joins flagged', value: String(view.joins), inline: true },
        { name: 'Rule type', value: 'RAID_DETECTION', inline: true },
        { name: 'Started', value: `<t:${seconds(view.startedAt)}:R>`, inline: true },
        { name: 'Status', value: status },
        { name: 'Actions', value: view.actionsText },
        {
          name: 'Review',
          value:
            'Every flagged join is recorded individually. Use `/automod review` or the dashboard to go through them.',
        },
      )
      .setTimestamp(view.ended ? view.lastJoinAt : view.startedAt)
  );
}

async function scheduleUpdate(ctx: PluginContext, data: RaidAlertJobData): Promise<void> {
  await ctx.queue(RAID_ALERT_JOB_NAME).add(RAID_ALERT_JOB_NAME, data, {
    // `-` separators: BullMQ rejects most custom job ids containing `:` (see moderation's expiry job).
    jobId: `raid-${data.guildId}-${data.ruleId}-${data.startedAt}-${data.tick}`,
    delay: RAID_ALERT_UPDATE_INTERVAL_MS,
    removeOnComplete: true,
    removeOnFail: 100,
  });
}

/**
 * Records one flagged join for `ruleId`'s raid alert. The first join of a raid posts the alert and starts the
 * update job; every other join is a single Redis call and nothing else.
 */
export async function recordRaidAlertJoin(
  ctx: PluginContext,
  guild: Guild,
  params: {
    ruleId: string;
    ruleName: string;
    alertChannelId: string | null;
    reason: string;
    actionsText: string;
    dryRun: boolean;
  },
): Promise<void> {
  const key = stateKey(guild.id, params.ruleId);
  const now = Date.now();
  const [startedNow, startedAtRaw] = (await ctx.redis.eval(
    RECORD_JOIN_SCRIPT,
    1,
    key,
    now,
    RAID_ALERT_STALE_MS,
    RAID_ALERT_STATE_TTL_SECONDS,
  )) as [number, string];
  if (startedNow !== 1) return;

  const startedAt = Number(startedAtRaw);
  await ctx.redis.hset(key, {
    ruleName: params.ruleName,
    reason: params.reason,
    actionsText: params.actionsText,
    dryRun: params.dryRun ? '1' : '0',
  });

  // Scheduled before the post is attempted, so the raid is still closed out (and its state removed) even when
  // the alert itself cannot be posted.
  await scheduleUpdate(ctx, { guildId: guild.id, ruleId: params.ruleId, startedAt, tick: 1 }).catch(
    (err: unknown) => {
      ctx.logger.error(
        { guildId: guild.id, ruleId: params.ruleId, err: err instanceof Error ? err.message : String(err) },
        'automod: failed to schedule raid alert updates; the alert will not show a running count',
      );
    },
  );

  if (!params.alertChannelId) {
    ctx.logger.warn(
      { guildId: guild.id, ruleId: params.ruleId },
      'automod: alert_staff action configured but no alertChannelId set',
    );
    return;
  }
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
        raidAlertEmbed({
          ruleName: params.ruleName,
          reason: params.reason,
          actionsText: params.actionsText,
          dryRun: params.dryRun,
          joins: 1,
          startedAt,
          lastJoinAt: startedAt,
          ended: false,
        }),
      ],
      allowedMentions: { parse: [] },
    });
    // Only if this raid is still the current one: a slow post must not attach its message to a later raid.
    if ((await ctx.redis.hget(key, 'startedAt')) === startedAtRaw) {
      await ctx.redis.hset(key, { messageId: message.id, channelId: channel.id, shown: '1' });
    }
  } catch (err) {
    ctx.logger.error(
      { guildId: guild.id, err: err instanceof Error ? err.message : String(err) },
      'automod: failed to post raid alert',
    );
  }
}

/**
 * The update job: edits the raid's one alert message when the count has changed, and closes the raid out once it
 * has gone quiet. Re-queues itself while the raid is in progress, so there is never more than one edit per
 * `RAID_ALERT_UPDATE_INTERVAL_MS` for a raid.
 */
export const raidAlertJob: PluginJob<RaidAlertJobData> = {
  name: RAID_ALERT_JOB_NAME,
  concurrency: 5,
  async processor(ctx, job) {
    const { guildId, ruleId, startedAt, tick } = job.data;
    const key = stateKey(guildId, ruleId);
    const state = await ctx.redis.hgetall(key);
    // Gone (closed, expired) or replaced by a newer raid for the same rule: this job has nothing left to do.
    if (Number(state.startedAt) !== startedAt) return;

    const now = Date.now();
    const closed =
      (await ctx.redis.eval(CLOSE_IF_QUIET_SCRIPT, 1, key, String(startedAt), now, RAID_ALERT_QUIET_MS)) ===
      1;

    const joins = Number(state.joins ?? 0);
    const lastJoinAt = Number(state.lastJoinAt ?? startedAt);
    if (state.messageId && state.channelId && (closed || String(joins) !== state.shown)) {
      try {
        const guild =
          ctx.client.guilds.cache.get(guildId) ?? (await ctx.client.guilds.fetch(guildId).catch(() => null));
        const channel = guild ? await resolveTextChannel(guild, state.channelId) : null;
        if (!channel) throw new Error('alert channel is no longer available');
        await channel.messages.edit(state.messageId, {
          embeds: [
            raidAlertEmbed({
              ruleName: state.ruleName ?? 'Raid detection',
              reason: state.reason ?? 'A configured rule matched.',
              actionsText: state.actionsText ?? '_None configured_',
              dryRun: state.dryRun === '1',
              joins,
              startedAt,
              lastJoinAt,
              ended: closed,
            }),
          ],
          allowedMentions: { parse: [] },
        });
        if (!closed) await ctx.redis.hset(key, 'shown', String(joins));
      } catch (err) {
        // A deleted alert or a lost permission must not stop the raid from being tracked and closed out.
        ctx.logger.warn(
          { guildId, ruleId, err: err instanceof Error ? err.message : String(err) },
          'automod: failed to update raid alert',
        );
      }
    }

    if (!closed) await scheduleUpdate(ctx, { guildId, ruleId, startedAt, tick: tick + 1 });
  },
};
