import { createHmac, randomUUID } from 'node:crypto';

export interface SignedOutboundRequest {
  body: string;
  headers: Record<string, string>;
  deliveryId: string;
}

/** Builds the signed JSON body + headers for an outbound webhook POST (SPEC.md §J / ARCHITECTURE.md's
 * integrations connector spec): `X-Pavisie-Event`, `X-Pavisie-Signature` (HMAC-SHA256 hex of the body,
 * verifiable with core's `verifyHmacSha256`), `X-Pavisie-Delivery` (a fresh id per attempt-set). */
export function signOutboundPayload(
  payload: unknown,
  secret: string,
  eventType: string,
  deliveryId: string = randomUUID(),
): SignedOutboundRequest {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  return {
    body,
    deliveryId,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Pavisie-Webhooks/1.0',
      'X-Pavisie-Event': eventType,
      'X-Pavisie-Signature': signature,
      'X-Pavisie-Delivery': deliveryId,
    },
  };
}

/** BullMQ options for outbound delivery attempts (ARCHITECTURE.md: "attempts 5 exponential backoff 30s"). */
export const OUTBOUND_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: { age: 60 * 60 * 24, count: 500 },
  removeOnFail: { age: 60 * 60 * 24 * 7 },
};

/** Consecutive failures after which an outbound endpoint auto-disables (ARCHITECTURE.md's integrations connector spec). */
export const OUTBOUND_AUTO_DISABLE_THRESHOLD = 20;
