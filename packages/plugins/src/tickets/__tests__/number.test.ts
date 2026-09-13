import { Prisma } from '@pavisie/database';
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../sdk/testing';
import { nextTicketNumber, withNextTicketNumber } from '../number';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.0.0',
  });
}

describe('nextTicketNumber', () => {
  it('returns 1 for a guild with no tickets yet', async () => {
    const { ctx } = createTestContext({
      prismaOverrides: { ticket: { aggregate: () => Promise.resolve({ _max: { number: null } }) } },
    });
    await expect(nextTicketNumber(ctx.prisma, 'g1')).resolves.toBe(1);
  });

  it('returns MAX(number) + 1', async () => {
    const { ctx } = createTestContext({
      prismaOverrides: { ticket: { aggregate: () => Promise.resolve({ _max: { number: 7 } }) } },
    });
    await expect(nextTicketNumber(ctx.prisma, 'g1')).resolves.toBe(8);
  });
});

describe('withNextTicketNumber', () => {
  it('calls create with the allocated number and returns its result', async () => {
    const { ctx } = createTestContext({
      prismaOverrides: {
        ticket: {
          aggregate: () => Promise.resolve({ _max: { number: 4 } }),
          create: (args: unknown) => Promise.resolve({ id: 't1', ...(args as { data: object }).data }),
        },
      },
    });

    const result = await withNextTicketNumber(ctx.prisma, 'g1', (number) =>
      ctx.prisma.ticket.create({ data: { number, guildId: 'g1', openerId: 'u1', mode: 'CHANNEL' } }),
    );
    expect(result).toMatchObject({ number: 5 });
  });

  it('retries on a P2002 unique-constraint violation and succeeds on the next attempt', async () => {
    let attempts = 0;
    const { ctx } = createTestContext({
      prismaOverrides: {
        ticket: {
          aggregate: () => Promise.resolve({ _max: { number: 1 } }),
          create: () => {
            attempts += 1;
            if (attempts === 1) return Promise.reject(p2002());
            return Promise.resolve({ id: 't2', number: 2 });
          },
        },
      },
    });

    const result = await withNextTicketNumber(ctx.prisma, 'g1', (number) =>
      ctx.prisma.ticket.create({ data: { number, guildId: 'g1', openerId: 'u1', mode: 'CHANNEL' } }),
    );
    expect(attempts).toBe(2);
    expect(result).toMatchObject({ number: 2 });
  });

  it('gives up and rethrows after 3 consecutive P2002 failures', async () => {
    const { ctx } = createTestContext({
      prismaOverrides: {
        ticket: {
          aggregate: () => Promise.resolve({ _max: { number: 1 } }),
          create: () => Promise.reject(p2002()),
        },
      },
    });

    await expect(
      withNextTicketNumber(ctx.prisma, 'g1', (number) =>
        ctx.prisma.ticket.create({ data: { number, guildId: 'g1', openerId: 'u1', mode: 'CHANNEL' } }),
      ),
    ).rejects.toThrow();
  });

  it('does not retry on a non-P2002 error', async () => {
    let attempts = 0;
    const { ctx } = createTestContext({
      prismaOverrides: {
        ticket: {
          aggregate: () => Promise.resolve({ _max: { number: 1 } }),
          create: () => {
            attempts += 1;
            return Promise.reject(new Error('database is down'));
          },
        },
      },
    });

    await expect(
      withNextTicketNumber(ctx.prisma, 'g1', (number) =>
        ctx.prisma.ticket.create({ data: { number, guildId: 'g1', openerId: 'u1', mode: 'CHANNEL' } }),
      ),
    ).rejects.toThrow('database is down');
    expect(attempts).toBe(1);
  });
});
