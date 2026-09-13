// Ticket number allocation, mirroring `@pavisie/database`'s `nextCaseNumber`/`withNextCaseNumber` pattern
// (packages/database/src/guild.ts) for `Ticket.number` — kept local since that helper is specific to
// `ModerationCase`/`EnforcerRecord` and this plugin doesn't own the database package.
import { Prisma, type PrismaClient } from '@pavisie/database';

/**
 * Computes the next `Ticket.number` for a guild as `MAX(number) + 1`. A single `aggregate` read needs no
 * explicit transaction wrapper to be atomic on its own.
 *
 * RACE WINDOW (same caveat as `nextCaseNumber`): two concurrent callers can compute the same next number.
 * Correctness is enforced by the `@@unique([guildId, number])` constraint on `Ticket`, not by this read alone —
 * callers MUST retry on a Prisma unique-violation (`P2002`). `withNextTicketNumber` implements that retry.
 */
export async function nextTicketNumber(prisma: PrismaClient, guildId: string): Promise<number> {
  const agg = await prisma.ticket.aggregate({ where: { guildId }, _max: { number: true } });
  return (agg._max.number ?? 0) + 1;
}

const TICKET_NUMBER_MAX_ATTEMPTS = 3;

/** Fetches the next ticket number and calls `create(number)`, retrying up to 3 times on a `[guildId, number]` P2002 violation. */
export async function withNextTicketNumber<T>(
  prisma: PrismaClient,
  guildId: string,
  create: (number: number) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TICKET_NUMBER_MAX_ATTEMPTS; attempt++) {
    const number = await nextTicketNumber(prisma, guildId);
    try {
      return await create(number);
    } catch (err) {
      lastError = err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
