import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OUTBOUND_AUTO_DISABLE_THRESHOLD, OUTBOUND_JOB_OPTIONS, signOutboundPayload } from '../signing';

describe('signOutboundPayload', () => {
  it('produces a verifiable HMAC-SHA256 signature over the exact JSON body', () => {
    const secret = 'top-secret';
    const payload = { event: 'moderation.caseCreated', guildId: '1', data: { caseNumber: 5 } };
    const signed = signOutboundPayload(payload, secret, 'moderation.caseCreated', 'delivery-1');

    expect(signed.body).toBe(JSON.stringify(payload));
    expect(signed.headers['X-Pavisie-Event']).toBe('moderation.caseCreated');
    expect(signed.headers['X-Pavisie-Delivery']).toBe('delivery-1');
    expect(signed.headers['Content-Type']).toBe('application/json');

    const expected = createHmac('sha256', secret).update(signed.body).digest('hex');
    expect(signed.headers['X-Pavisie-Signature']).toBe(expected);
  });

  it('generates a fresh delivery id per call when none is given', () => {
    const a = signOutboundPayload({ a: 1 }, 's', 'custom');
    const b = signOutboundPayload({ a: 1 }, 's', 'custom');
    expect(a.deliveryId).not.toBe(b.deliveryId);
  });

  it('produces a different signature for a different secret (tamper-evidence)', () => {
    const payload = { a: 1 };
    const signed1 = signOutboundPayload(payload, 'secret-a', 'custom', 'd1');
    const signed2 = signOutboundPayload(payload, 'secret-b', 'custom', 'd1');
    expect(signed1.headers['X-Pavisie-Signature']).not.toBe(signed2.headers['X-Pavisie-Signature']);
  });
});

describe('OUTBOUND_JOB_OPTIONS', () => {
  it('retries up to 5 times with a 30s exponential backoff (ARCHITECTURE.md integrations connector spec)', () => {
    expect(OUTBOUND_JOB_OPTIONS.attempts).toBe(5);
    expect(OUTBOUND_JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 30_000 });
  });
});

describe('OUTBOUND_AUTO_DISABLE_THRESHOLD', () => {
  it('auto-disables after 20 consecutive failures', () => {
    expect(OUTBOUND_AUTO_DISABLE_THRESHOLD).toBe(20);
  });
});
