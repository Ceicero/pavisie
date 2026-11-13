-- Per-endpoint opt-in replay protection for inbound generic webhooks: when true, deliveries must carry an
-- `X-Pavisie-Timestamp` header (signed together with the body and within 5 minutes of now). Additive, defaults to
-- false so existing endpoints/senders are unaffected.
ALTER TABLE "WebhookEndpoint" ADD COLUMN "requireTimestamp" BOOLEAN NOT NULL DEFAULT false;
