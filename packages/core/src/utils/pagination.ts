import type { Paginated } from '@pavisie/types';

export interface PaginateParams {
  cursor?: string | null;
  limit?: number;
  defaultLimit?: number;
  maxLimit?: number;
}

export interface PaginateResolved {
  limit: number;
  offset: number;
}

/** Decodes an opaque pagination cursor back into a numeric offset; invalid/missing input yields `undefined`. */
export function decodeCursor(cursor: string | null | undefined): number | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const n = Number(decoded);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Encodes a numeric offset as an opaque pagination cursor. */
export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

/** Resolves raw pagination query params (cursor, limit) into a safe `{ limit, offset }`, clamped to sane bounds. */
export function paginate(params: PaginateParams = {}): PaginateResolved {
  const defaultLimit = params.defaultLimit ?? 25;
  const maxLimit = params.maxLimit ?? 100;
  const rawLimit = params.limit ?? defaultLimit;
  const limit = Math.min(Math.max(Math.floor(rawLimit), 1), maxLimit);
  const offset = decodeCursor(params.cursor) ?? 0;
  return { limit, offset };
}

/**
 * Builds a `Paginated<T>` response. Callers should fetch `limit + 1` rows and pass all of them here —
 * the extra row (if present) signals there's a next page and is stripped from `items`.
 */
export function buildPaginated<T>(
  fetchedItems: T[],
  limit: number,
  currentOffset: number,
  total?: number,
): Paginated<T> {
  const hasMore = fetchedItems.length > limit;
  const items = hasMore ? fetchedItems.slice(0, limit) : fetchedItems;
  const nextCursor = hasMore ? encodeCursor(currentOffset + limit) : null;
  return { items, nextCursor, total };
}
