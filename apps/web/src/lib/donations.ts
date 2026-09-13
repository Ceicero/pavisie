import type { DonationConfigDto } from '@pavisie/types';
import { apiUrl } from './site';

/** Server-side fetch of `GET /donations/config`. Never cached — Ko-fi URL can change without a rebuild,
 * and this call happens at request time so the production build never needs the API reachable at build time.
 * Never throws for an ordinary "unavailable" response — that's a valid, renderable state the page handles
 * explicitly. */
export async function fetchDonationConfig(): Promise<DonationConfigDto> {
  try {
    const res = await fetch(`${apiUrl()}/donations/config`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Unexpected status ${res.status}`);
    return (await res.json()) as DonationConfigDto;
  } catch {
    // API unreachable (down, misconfigured URL, offline build preview, etc.) degrades gracefully with
    // donations disabled — the page shows the honest empty state.
    return {
      enabled: false,
      kofiUrl: null,
    };
  }
}
