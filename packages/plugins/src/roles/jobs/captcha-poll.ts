import { redisKey } from '@entrophy/core';
import type { PluginJob } from '../../sdk';

interface VerifyTokenContext {
  guildId: string;
  userId: string;
}

function parseTokenContext(raw: string | null): VerifyTokenContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VerifyTokenContext>;
    if (typeof parsed.guildId === 'string' && typeof parsed.userId === 'string') {
      return { guildId: parsed.guildId, userId: parsed.userId };
    }
  } catch {
    // Malformed value; treated as no context below.
  }
  return null;
}

/**
 * Every 15s: scans for `entrophy:verify:done:<token>` keys (written by the CAPTCHA completion page — the
 * wiring stage adds the actual `/verify/:token` page; this job only implements the polling side of the
 * Redis contract documented in README.md), resolves the `{guildId, userId}` context from the matching
 * `entrophy:verify:pending:<token>` key (or the done key's own value as a fallback), grants the verified
 * role via the `roles` service, and deletes both keys so a token can't be replayed.
 */
export const captchaPollJob: PluginJob = {
  name: 'captcha-poll',
  // 6-field cron (seconds first) — every 15 seconds. Requires the cron parser bullmq uses to accept a
  // seconds field (cron-parser@4.x does).
  repeat: { pattern: '*/15 * * * * *' },
  async processor(ctx) {
    const pattern = redisKey('verify', 'done', '*');
    let cursor = '0';

    do {
      const [nextCursor, keys] = await ctx.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      for (const doneKey of keys) {
        const token = doneKey.split(':').pop();
        if (!token) continue;

        const pendingKey = redisKey('verify', 'pending', token);
        const [doneValue, pendingValue] = await Promise.all([
          ctx.redis.get(doneKey),
          ctx.redis.get(pendingKey),
        ]);
        const tokenContext = parseTokenContext(pendingValue) ?? parseTokenContext(doneValue);

        if (!tokenContext) {
          ctx.logger.warn(
            { token },
            'roles: captcha-poll found a done token with no resolvable guild/user context',
          );
          // Clean up malformed tokens immediately
          await ctx.redis.del(doneKey, pendingKey);
          continue;
        }

        const roles = ctx.services.get('roles');
        if (!roles) {
          ctx.logger.warn(
            { token, guildId: tokenContext.guildId },
            'roles: captcha-poll could not grant the verified role — roles service unavailable',
          );
          // Leave tokens in place for retry; they will expire naturally after 10 minutes
          continue;
        }

        try {
          await roles.verifyMember({
            guildId: tokenContext.guildId,
            userId: tokenContext.userId,
            method: 'captcha',
          });
          // Only delete tokens after successful verification
          await ctx.redis.del(doneKey, pendingKey);
        } catch (err) {
          ctx.logger.error(
            {
              err: err instanceof Error ? err.message : String(err),
              guildId: tokenContext.guildId,
              userId: tokenContext.userId,
            },
            'roles: captcha-poll failed to verify member; tokens retained for retry',
          );
          // Leave tokens in place for retry (job runs every 15s; token TTL is 600s = ~40 retries max)
        }
      }
    } while (cursor !== '0');
  },
};
