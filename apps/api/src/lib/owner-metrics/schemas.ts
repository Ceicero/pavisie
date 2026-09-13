import { z } from 'zod';
import { paginationQuerySchema, snowflakeSchema } from '../schemas';

/** `GET /owner/metrics/guilds` query — search + presence filter plus the shared cursor/limit pagination params. */
export const ownerMetricsGuildsQuerySchema = paginationQuerySchema.extend({
  /** Matched against `Guild.name` (case-insensitive substring) or `Guild.id` (substring). */
  query: z.string().trim().min(1).max(200).optional(),
  botPresent: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

/** The four models carrying an error column — see `@pavisie/types` `OwnerMetricsErrorSource` for why. */
export const OWNER_METRICS_ERROR_SOURCES = ['integration', 'job', 'webhook', 'data-request'] as const;
export const ownerMetricsErrorSourceSchema = z.enum(OWNER_METRICS_ERROR_SOURCES);

/** `GET /owner/metrics/errors` query — filters plus the shared cursor/limit pagination params. */
export const ownerMetricsErrorsQuerySchema = paginationQuerySchema.extend({
  source: ownerMetricsErrorSourceSchema.optional(),
  guildId: snowflakeSchema.optional(),
});

/**
 * `GET /owner/metrics/growth` query. Deliberately permissive (not `.min(1).max(365)`, which would 400 an
 * out-of-range value): the contract calls for `days` to be *clamped* into range, so the route clamps it itself
 * after parsing — see `owner-metrics.ts`.
 */
export const ownerMetricsGrowthQuerySchema = z.object({
  days: z.coerce.number().int().optional(),
});
