// `/donations/config` (NOT under `/guilds`, not session-authenticated) — returns Ko-fi configuration.
// Public, no rate limiting, no personal data stored.
import type { ZodFastifyInstance } from '../lib/http';
import { env } from '@pavisie/core';
import type { DonationConfigDto } from '@pavisie/types';

/** `/donations/*` — Ko-fi donation config endpoint. */
export default async function donationsRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get<{ Reply: DonationConfigDto }>('/config', async (): Promise<DonationConfigDto> => {
    return {
      enabled: Boolean(env.KOFI_URL),
      kofiUrl: env.KOFI_URL ?? null,
    };
  });
}
