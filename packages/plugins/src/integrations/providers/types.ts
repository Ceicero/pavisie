import type { z } from 'zod';
import type { IntegrationConnection } from '@pavisie/database';
import type { IntegrationProviderId, IntegrationProviderKind } from '@pavisie/types/integrations';
import type { PluginContext } from '../../sdk';

/** A normalized inbound event handed to a provider's `handleInbound`, built by the `inbound` job processor from
 * the API webhook route's queue payload (ARCHITECTURE.md's integrations connector spec / `apps/api/src/routes/webhooks.ts`). */
export interface InboundWebhookEvent {
  eventType: string;
  payload: unknown;
  /** Present for per-guild inbound endpoints (github, generic); absent for shared global endpoints (stripe, twitch). */
  endpointId?: string;
  /** Present when the API route could resolve it directly from the endpoint row (github, generic). */
  guildId?: string;
}

export interface ProviderHealthResult {
  status: 'ok' | 'degraded' | 'error';
  detail?: string;
}

/**
 * One connector (SPEC.md §J). `poll` and `handleInbound` are both optional — a provider implements whichever
 * fits its transport (poll for API-pull connectors, handleInbound for webhook-pushed ones; twitch implements both).
 */
export interface IntegrationProviderDef {
  id: IntegrationProviderId;
  name: string;
  kind: IntegrationProviderKind;
  /** ALL must be set (non-empty) for this provider to be usable; checked per-call, not just at plugin load. */
  requiredEnv: string[];
  /** How often `poll` should run for a connection of this provider, informational (actual cadence set by the job's cron). */
  pollIntervalSeconds?: number;
  /** Per-connection public config shape (target, channel, role, template, ...). */
  configSchema: z.ZodTypeAny;
  poll?(ctx: PluginContext, connection: IntegrationConnection): Promise<void>;
  /** `connection` is `null` when the event can't be resolved to one connection ahead of time (twitch, stripe — the
   * provider itself looks up the right connection(s) from `event.payload`). */
  handleInbound?(
    ctx: PluginContext,
    connection: IntegrationConnection | null,
    event: InboundWebhookEvent,
  ): Promise<void>;
  health?(ctx: PluginContext, connection: IntegrationConnection): Promise<ProviderHealthResult>;
}

/** True if every `requiredEnv` var is set (non-empty) on `env`. */
export function isProviderEnvSatisfied(requiredEnv: string[], env: Record<string, unknown>): boolean {
  return requiredEnv.every((key) => {
    const value = env[key];
    return value !== undefined && value !== null && value !== '';
  });
}
