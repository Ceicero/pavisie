import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../sdk/testing';
import { createRolesService } from '../service';

// ---------------------------------------------------------------------------
// BUG 3: Verification approve/deny race — atomic update with PENDING check
// ---------------------------------------------------------------------------

describe('verification decision race condition — BUG 3 fixes', () => {
  /**
   * Stands in for the one `VerificationRequest` row under test. `updateMany` honours the `status: 'PENDING'`
   * guard the way Postgres would — it only matches while the row is still pending, and reports how many rows it
   * actually changed — which is precisely what the fix relies on to let exactly one decision win.
   */
  function pendingRequestContext() {
    const row = {
      id: 'req-1',
      guildId: 'guild-1',
      userId: 'user-1',
      status: 'PENDING',
      reviewedBy: null as string | null,
      staffMessageId: null,
    };
    const { ctx } = createTestContext({
      prismaOverrides: {
        verificationRequest: {
          findFirst: () => Promise.resolve({ ...row }),
          updateMany: (...args: unknown[]) => {
            if (row.status !== 'PENDING') return Promise.resolve({ count: 0 });
            const { data } = args[0] as { data: Record<string, unknown> };
            Object.assign(row, data);
            return Promise.resolve({ count: 1 });
          },
        },
      },
    });
    // The decision path ends by fetching the guild to DM the requester; `createTestContext` ships an empty
    // client, so stand in one whose fetch rejects. The service already treats that as "no guild" and skips the
    // DM, which keeps this test on the race guard rather than on Discord plumbing.
    (ctx as { client: unknown }).client = {
      guilds: { fetch: () => Promise.reject(new Error('no guild in tests')) },
    };
    return { ctx, row };
  }

  it('lets only the first of two decisions win, and tells the loser it was already decided', async () => {
    const { ctx, row } = pendingRequestContext();
    const service = createRolesService(ctx);

    // Deny rather than approve so the assertion stays on the race guard itself: approving would additionally
    // run the member-verification path, which is covered by its own tests.
    await service.verificationDecision({
      guildId: 'guild-1',
      requestId: 'req-1',
      approve: false,
      reviewerId: 'mod-1',
    });
    expect(row.status).toBe('DENIED');
    expect(row.reviewedBy).toBe('mod-1');

    await expect(
      service.verificationDecision({
        guildId: 'guild-1',
        requestId: 'req-1',
        approve: true,
        reviewerId: 'mod-2',
      }),
    ).rejects.toThrow(/already decided/i);

    // The second moderator must not have overwritten the first decision.
    expect(row.status).toBe('DENIED');
    expect(row.reviewedBy).toBe('mod-1');
  });
});

// ---------------------------------------------------------------------------
// BUG 4: CAPTCHA tokens retention on failure
// ---------------------------------------------------------------------------

describe('CAPTCHA token handling — BUG 4 fixes', () => {
  it('malformed tokens (no context) are deleted immediately', async () => {
    const { ctx } = createTestContext();

    const token = 'malformed-token';
    const doneKey = `pavisie:verify:done:${token}`;
    const pendingKey = `pavisie:verify:pending:${token}`;

    // Set up tokens with no valid context
    await ctx.redis.set(doneKey, 'invalid-json', 'EX', 600);
    await ctx.redis.set(pendingKey, 'invalid-json', 'EX', 600);

    expect(await ctx.redis.get(doneKey)).toBe('invalid-json');

    // Run the captcha poll job
    const { captchaPollJob } = await import('../jobs/captcha-poll');
    await captchaPollJob.processor(ctx, {} as never);

    // Malformed tokens should be deleted immediately (the fix handles this case)
    expect(await ctx.redis.get(doneKey)).toBeNull();
    expect(await ctx.redis.get(pendingKey)).toBeNull();
  });

  it('tokens are retained when roles service is unavailable', async () => {
    const { ctx } = createTestContext();

    const token = 'test-token-no-service';
    const guildId = 'guild-unavailable';
    const userId = 'user-x';

    const doneKey = `pavisie:verify:done:${token}`;
    const pendingKey = `pavisie:verify:pending:${token}`;
    const context = JSON.stringify({ guildId, userId });

    await ctx.redis.set(doneKey, context, 'EX', 600);
    await ctx.redis.set(pendingKey, context, 'EX', 600);

    // createTestContext registers no services, so `roles` is already unavailable here.
    // Run the captcha poll job
    const { captchaPollJob } = await import('../jobs/captcha-poll');
    await captchaPollJob.processor(ctx, {} as never);

    // Tokens should STILL be in Redis when service is unavailable (the fix: leave for retry)
    expect(await ctx.redis.get(doneKey)).toBe(context);
    expect(await ctx.redis.get(pendingKey)).toBe(context);
  });
});
