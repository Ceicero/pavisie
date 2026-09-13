import { Prisma, type PrismaClient } from '@pavisie/database';
import { describe, expect, it } from 'vitest';
import { withNextRecordNumber } from '../service';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.0.0',
  });
}

/**
 * `withNextRecordNumber` calls `@pavisie/database`'s `nextEnforcerRecordNumber`, which wraps its `aggregate`
 * read in `prisma.$transaction(async tx => ...)`. The SDK's generic `createPrismaStub` (sdk/testing.ts) can't
 * stub a directly-callable `prisma.$transaction` (every property access returns a nested method proxy, never a
 * callable function) — packages/plugins/src/tickets/number.ts hit the same limitation and worked around it by
 * avoiding `$transaction` entirely. `nextEnforcerRecordNumber` isn't ours to change, so this test uses a small
 * hand-built fake instead of the shared stub.
 */
function fakePrisma(
  existingMax: number | null,
  createImpl: (recordNumber: number) => Promise<unknown>,
): PrismaClient {
  return {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ enforcerRecord: { aggregate: async () => ({ _max: { recordNumber: existingMax } }) } }),
    enforcerRecord: {
      create: (args: { data: { recordNumber: number } }) => createImpl(args.data.recordNumber),
    },
  } as unknown as PrismaClient;
}

describe('withNextRecordNumber', () => {
  it('starts at 1 for a guild with no records yet', async () => {
    const prisma = fakePrisma(null, (n) => Promise.resolve({ recordNumber: n }));
    const result = await withNextRecordNumber(prisma, 'g1', (n) =>
      prisma.enforcerRecord.create({ data: { recordNumber: n } as never }),
    );
    expect(result).toMatchObject({ recordNumber: 1 });
  });

  it('allocates MAX(recordNumber) + 1', async () => {
    const prisma = fakePrisma(7, (n) => Promise.resolve({ recordNumber: n }));
    const result = await withNextRecordNumber(prisma, 'g1', (n) =>
      prisma.enforcerRecord.create({ data: { recordNumber: n } as never }),
    );
    expect(result).toMatchObject({ recordNumber: 8 });
  });

  it('retries on a P2002 unique-constraint violation and succeeds on the next attempt', async () => {
    let attempts = 0;
    const prisma = fakePrisma(1, (n) => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(p2002());
      return Promise.resolve({ recordNumber: n });
    });

    const result = await withNextRecordNumber(prisma, 'g1', (n) =>
      prisma.enforcerRecord.create({ data: { recordNumber: n } as never }),
    );
    expect(attempts).toBe(2);
    expect(result).toMatchObject({ recordNumber: 2 });
  });

  it('gives up and rethrows after 3 consecutive P2002 failures', async () => {
    const prisma = fakePrisma(1, () => Promise.reject(p2002()));
    await expect(
      withNextRecordNumber(prisma, 'g1', (n) =>
        prisma.enforcerRecord.create({ data: { recordNumber: n } as never }),
      ),
    ).rejects.toThrow();
  });

  it('does not retry on a non-P2002 error', async () => {
    let attempts = 0;
    const prisma = fakePrisma(1, () => {
      attempts += 1;
      return Promise.reject(new Error('database is down'));
    });

    await expect(
      withNextRecordNumber(prisma, 'g1', (n) =>
        prisma.enforcerRecord.create({ data: { recordNumber: n } as never }),
      ),
    ).rejects.toThrow('database is down');
    expect(attempts).toBe(1);
  });
});
