import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { describe, expect, it } from 'vitest';
import { redisKey } from '@pavisie/core';
import {
  MAX_VOICE_SESSION_MINUTES,
  MAX_VOICE_SESSION_SECONDS,
  canGiveRep,
  channelQualifiesForVoiceXp,
  computeLevelRewardPlan,
  countEligibleReactors,
  decideStarboardAction,
  hasVoiceSession,
  isEligibleVoiceMember,
  isOrphanTempVoiceChannel,
  levelFromXp,
  renderTempVoiceName,
  rollMessageXp,
  startVoiceSession,
  stopVoiceSession,
  takeRepCooldown,
  tryAwardMessageXp,
  voiceXpForMinutes,
  xpForLevel,
  xpToNextLevel,
  type VoiceMemberLike,
} from '../service';

// ioredis-mock shares its in-memory keyspace across `new RedisMock()` instances by default, so each test
// gets its own client AND flushes it before use to guarantee isolation from whatever ran before it.
async function freshRedis(): Promise<Redis> {
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  return redis;
}

describe('level math', () => {
  it('xpForLevel is monotonically non-decreasing', () => {
    let previous = -1;
    for (let level = 0; level <= 200; level++) {
      const value = xpForLevel(level);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('xpForLevel(0) is 0 and negative/zero levels are clamped to 0', () => {
    expect(xpForLevel(0)).toBe(0);
    expect(xpForLevel(-5)).toBe(0);
  });

  it('xpToNextLevel matches the per-level cost formula 5l^2 + 50l + 100', () => {
    expect(xpToNextLevel(0)).toBe(100);
    expect(xpToNextLevel(1)).toBe(155);
    expect(xpToNextLevel(2)).toBe(220);
  });

  it('levelFromXp is the exact inverse of xpForLevel at every threshold', () => {
    for (let level = 0; level <= 100; level++) {
      const threshold = xpForLevel(level);
      expect(levelFromXp(threshold)).toBe(level);
      if (level > 0) {
        expect(levelFromXp(threshold - 1)).toBe(level - 1);
      }
    }
  });

  it('levelFromXp is monotonically non-decreasing in xp', () => {
    let previousLevel = 0;
    for (let xp = 0; xp <= 5000; xp += 37) {
      const level = levelFromXp(xp);
      expect(level).toBeGreaterThanOrEqual(previousLevel);
      previousLevel = level;
    }
  });

  it('levelFromXp handles 0 and negative xp as level 0', () => {
    expect(levelFromXp(0)).toBe(0);
    expect(levelFromXp(-100)).toBe(0);
  });
});

describe('rollMessageXp', () => {
  it('stays within [min, max] inclusive across the rng range', () => {
    for (const rng of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const value = rollMessageXp(15, 25, () => rng);
      expect(value).toBeGreaterThanOrEqual(15);
      expect(value).toBeLessThanOrEqual(25);
    }
  });

  it('handles min === max', () => {
    expect(rollMessageXp(20, 20, () => 0.9)).toBe(20);
  });
});

describe('tryAwardMessageXp (Redis-backed)', () => {
  it('awards XP on the first message and blocks a second one inside the cooldown', async () => {
    const redis = await freshRedis();
    const config = { xpPerMessageMin: 15, xpPerMessageMax: 15, xpCooldownSeconds: 60, maxXpPerHour: 1000 };

    const first = await tryAwardMessageXp(redis, 'guild1', 'user1', config, () => 0);
    expect(first).toEqual({ awarded: true, xpGained: 15 });

    const second = await tryAwardMessageXp(redis, 'guild1', 'user1', config, () => 0);
    expect(second.awarded).toBe(false);
    expect(second.reason).toBe('cooldown');
  });

  it('enforces the rolling hourly cap, clamping the final grant', async () => {
    const redis = await freshRedis();
    const config = { xpPerMessageMin: 15, xpPerMessageMax: 15, xpCooldownSeconds: 0, maxXpPerHour: 20 };

    const first = await tryAwardMessageXp(redis, 'guild1', 'user1', config, () => 0);
    expect(first).toEqual({ awarded: true, xpGained: 15 });

    // Only 5 XP of headroom remains before the 20/hour cap.
    const second = await tryAwardMessageXp(redis, 'guild1', 'user1', config, () => 0);
    expect(second).toEqual({ awarded: true, xpGained: 5 });

    const third = await tryAwardMessageXp(redis, 'guild1', 'user1', config, () => 0);
    expect(third.awarded).toBe(false);
    expect(third.reason).toBe('hourly_cap');
  });

  it('tracks cooldown and hourly cap independently per user and per guild', async () => {
    const redis = await freshRedis();
    const config = { xpPerMessageMin: 10, xpPerMessageMax: 10, xpCooldownSeconds: 60, maxXpPerHour: 1000 };

    await tryAwardMessageXp(redis, 'guildA', 'user1', config, () => 0);
    const otherUser = await tryAwardMessageXp(redis, 'guildA', 'user2', config, () => 0);
    const otherGuild = await tryAwardMessageXp(redis, 'guildB', 'user1', config, () => 0);

    expect(otherUser.awarded).toBe(true);
    expect(otherGuild.awarded).toBe(true);
  });
});

describe('voice XP sessions (Redis-backed)', () => {
  it('starts, tracks, and stops a session, returning whole elapsed minutes', async () => {
    const redis = await freshRedis();
    const start = Date.now();

    await startVoiceSession(redis, 'guild1', 'user1', start);
    expect(await hasVoiceSession(redis, 'guild1', 'user1')).toBe(true);

    const minutes = await stopVoiceSession(redis, 'guild1', 'user1', start + 5.5 * 60_000);
    expect(minutes).toBe(5);
    expect(await hasVoiceSession(redis, 'guild1', 'user1')).toBe(false);
  });

  it('stopping a session that was never started is a no-op returning 0', async () => {
    const redis = await freshRedis();
    expect(await stopVoiceSession(redis, 'guild1', 'nobody')).toBe(0);
  });

  // A session is only settled by a voiceStateUpdate, so a missed leave event (redeploy, gateway reconnect)
  // would otherwise leave the start timestamp in Redis forever and pay it all out days later.
  it('writes the session key with an expiry so a missed leave event cannot leak it forever', async () => {
    const redis = await freshRedis();
    await startVoiceSession(redis, 'guild1', 'user1');

    const ttl = await redis.ttl(redisKey('engagement', 'voicesession', 'guild1', 'user1'));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(MAX_VOICE_SESSION_SECONDS);
  });

  it('clamps a resurrected (days-old) session to the maximum plausible session length', async () => {
    const redis = await freshRedis();
    const start = Date.now();

    await startVoiceSession(redis, 'guild1', 'user1', start);
    const minutes = await stopVoiceSession(redis, 'guild1', 'user1', start + 3 * 24 * 60 * 60_000);

    expect(minutes).toBe(MAX_VOICE_SESSION_MINUTES);
    expect(voiceXpForMinutes(minutes, 5)).toBe(MAX_VOICE_SESSION_MINUTES * 5);
  });

  it('voiceXpForMinutes multiplies minutes by the configured rate, floored and non-negative', () => {
    expect(voiceXpForMinutes(10, 5)).toBe(50);
    expect(voiceXpForMinutes(2.9, 5)).toBe(10);
    expect(voiceXpForMinutes(-3, 5)).toBe(0);
    expect(voiceXpForMinutes(10, -5)).toBe(0);
  });

  function member(overrides: Partial<VoiceMemberLike> = {}): VoiceMemberLike {
    return {
      id: 'x',
      isBot: false,
      selfMute: false,
      selfDeaf: false,
      serverMute: false,
      serverDeaf: false,
      ...overrides,
    };
  }

  it('isEligibleVoiceMember excludes bots and any muted/deafened state', () => {
    expect(isEligibleVoiceMember(member())).toBe(true);
    expect(isEligibleVoiceMember(member({ isBot: true }))).toBe(false);
    expect(isEligibleVoiceMember(member({ selfMute: true }))).toBe(false);
    expect(isEligibleVoiceMember(member({ selfDeaf: true }))).toBe(false);
    expect(isEligibleVoiceMember(member({ serverMute: true }))).toBe(false);
    expect(isEligibleVoiceMember(member({ serverDeaf: true }))).toBe(false);
  });

  it('channelQualifiesForVoiceXp requires at least 2 eligible members', () => {
    expect(channelQualifiesForVoiceXp([])).toBe(false);
    expect(channelQualifiesForVoiceXp([member({ id: 'a' })])).toBe(false);
    expect(channelQualifiesForVoiceXp([member({ id: 'a' }), member({ id: 'b', isBot: true })])).toBe(false);
    expect(channelQualifiesForVoiceXp([member({ id: 'a' }), member({ id: 'b' })])).toBe(true);
    expect(
      channelQualifiesForVoiceXp([
        member({ id: 'a' }),
        member({ id: 'b' }),
        member({ id: 'c', selfMute: true }),
      ]),
    ).toBe(true);
  });
});

describe('computeLevelRewardPlan', () => {
  const rewards = [
    { level: 5, roleId: 'role5' },
    { level: 10, roleId: 'role10' },
    { level: 20, roleId: 'role20' },
  ];

  it('stack: grants every reward at or below the level, never removes', () => {
    const plan = computeLevelRewardPlan([], rewards, 12, 'stack');
    expect(plan.toAdd.sort()).toEqual(['role10', 'role5']);
    expect(plan.toRemove).toEqual([]);
  });

  it('stack: does not re-add roles already held', () => {
    const plan = computeLevelRewardPlan(['role5'], rewards, 12, 'stack');
    expect(plan.toAdd).toEqual(['role10']);
    expect(plan.toRemove).toEqual([]);
  });

  it('replace: keeps only the highest applicable reward, removing the rest', () => {
    const plan = computeLevelRewardPlan(['role5'], rewards, 12, 'replace');
    expect(plan.toAdd).toEqual(['role10']);
    expect(plan.toRemove).toEqual(['role5']);
  });

  it('replace: no-op once the member already holds only the correct role', () => {
    const plan = computeLevelRewardPlan(['role10'], rewards, 12, 'replace');
    expect(plan.toAdd).toEqual([]);
    expect(plan.toRemove).toEqual([]);
  });

  it('replace: below the first reward level grants/removes nothing', () => {
    const plan = computeLevelRewardPlan([], rewards, 2, 'replace');
    expect(plan).toEqual({ toAdd: [], toRemove: [] });
  });
});

describe('reputation', () => {
  it('canGiveRep rejects self, allows anyone else', () => {
    expect(canGiveRep('u1', 'u1')).toEqual({ ok: false, reason: 'self' });
    expect(canGiveRep('u1', 'u2')).toEqual({ ok: true });
  });

  it('takeRepCooldown allows the first give and blocks a second within the window', async () => {
    const redis = await freshRedis();
    const first = await takeRepCooldown(redis, 'guild1', 'user1', 24);
    expect(first.ok).toBe(true);

    const second = await takeRepCooldown(redis, 'guild1', 'user1', 24);
    expect(second.ok).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it('takeRepCooldown is scoped per giver, not shared across users', async () => {
    const redis = await freshRedis();
    await takeRepCooldown(redis, 'guild1', 'user1', 24);
    const other = await takeRepCooldown(redis, 'guild1', 'user2', 24);
    expect(other.ok).toBe(true);
  });
});

describe('starboard threshold decisions', () => {
  it('does nothing below threshold when not yet posted', () => {
    expect(decideStarboardAction(false, 0, 2, 5)).toBe('none');
  });

  it('posts the moment the count crosses the threshold', () => {
    expect(decideStarboardAction(false, 4, 5, 5)).toBe('post');
  });

  it('updates the embed while posted and the count keeps changing', () => {
    expect(decideStarboardAction(true, 5, 6, 5)).toBe('update');
  });

  it('is a no-op while posted and the count is unchanged', () => {
    expect(decideStarboardAction(true, 6, 6, 5)).toBe('none');
  });

  it('removes the post once the count drops back below threshold', () => {
    expect(decideStarboardAction(true, 5, 4, 5)).toBe('remove');
  });

  it('countEligibleReactors dedupes and optionally excludes the author', () => {
    expect(countEligibleReactors(['a', 'b', 'a'], 'author', true)).toBe(2);
    expect(countEligibleReactors(['a', 'b', 'author'], 'author', true)).toBe(2);
    expect(countEligibleReactors(['a', 'b', 'author'], 'author', false)).toBe(3);
  });
});

describe('temp voice', () => {
  it('renderTempVoiceName substitutes {user} and truncates to the Discord channel-name limit', () => {
    expect(renderTempVoiceName("{user}'s channel", { user: 'Ada' })).toBe("Ada's channel");
    expect(renderTempVoiceName('no placeholder here', { user: 'Ada' })).toBe('no placeholder here');
    const long = renderTempVoiceName('x'.repeat(150), { user: 'Ada' });
    expect(long.length).toBe(100);
  });

  it('renderTempVoiceName falls back to a sane default if the template renders empty', () => {
    expect(renderTempVoiceName('   ', { user: 'Ada' })).toBe("Ada's channel");
  });

  it('isOrphanTempVoiceChannel is true only at zero (or fewer) members', () => {
    expect(isOrphanTempVoiceChannel(0)).toBe(true);
    expect(isOrphanTempVoiceChannel(-1)).toBe(true);
    expect(isOrphanTempVoiceChannel(1)).toBe(false);
  });
});
