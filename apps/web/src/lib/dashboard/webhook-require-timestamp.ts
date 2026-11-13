import type { WebhookEndpointDetailDto } from '@pavisie/types/integrations';
import { ApiClientError, apiFetch } from './api';

/** Exact copy shown next to the incoming-webhook "Require timestamp" control. */
export const REQUIRE_TIMESTAMP_HELP =
  'When on, each delivery must include X-Pavisie-Timestamp (Unix seconds), and X-Pavisie-Signature must be the hex HMAC-SHA256 of the timestamp, a full stop, then the raw body, using the endpoint secret. Deliveries more than 5 minutes off, or missing the header, are rejected with 401.';

/** `true` only when the API explicitly sent `true`. Missing or any other value is off. */
export function readRequireTimestamp(endpoint: { requireTimestamp?: boolean } | null | undefined): boolean {
  return endpoint?.requireTimestamp === true;
}

/** Sets `requireTimestamp` on one list row, leaving every other row untouched. */
export function applyRequireTimestamp<T extends { id: string }>(
  items: readonly T[] | undefined,
  endpointId: string,
  requireTimestamp: boolean,
): T[] | undefined {
  if (!items) return undefined;
  return items.map((item) => (item.id === endpointId ? { ...item, requireTimestamp } : item));
}

const REQUIRE_TIMESTAMP_ERROR_MESSAGES: Record<string, string> = {
  validation_error: 'That change was rejected. Refresh the page and try the toggle again.',
  unauthenticated: "You're signed out. Sign in again, then try the toggle.",
  permission_denied: "You don't have permission to change this webhook.",
  not_found: 'This webhook no longer exists. Refresh the page to see the current list.',
  rate_limited: 'Too many changes at once. Wait a moment, then try the toggle again.',
};

/** Friendly copy for a failed require-timestamp save. Known API codes never surface as raw codes. */
export function requireTimestampErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    return REQUIRE_TIMESTAMP_ERROR_MESSAGES[err.code] ?? err.message;
  }
  return 'Please try again.';
}

/**
 * `PATCH /guilds/:guildId/integrations/webhooks/:endpointId` with the only accepted field.
 * Uses the dashboard API client (session cookie via `credentials: 'include'`, `X-CSRF-Token`).
 */
export function patchInboundWebhookRequireTimestamp(
  guildId: string,
  endpointId: string,
  requireTimestamp: boolean,
): Promise<WebhookEndpointDetailDto> {
  return apiFetch<WebhookEndpointDetailDto>(`/guilds/${guildId}/integrations/webhooks/${endpointId}`, {
    method: 'PATCH',
    body: { requireTimestamp },
  });
}
