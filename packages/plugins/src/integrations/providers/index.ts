import type { IntegrationProvider as PrismaIntegrationProvider } from '@pavisie/database';
import {
  INTEGRATION_PROVIDER_IDS,
  type IntegrationProviderId,
  type IntegrationProviderInfoDto,
} from '@pavisie/types/integrations';
import { genericWebhookProvider } from './generic-webhook';
import { googleCalendarProvider } from './google-calendar';
import { instagramProvider } from './instagram';
import { microsoftCalendarProvider } from './microsoft-calendar';
import { redditProvider } from './reddit';
import { steamProvider } from './steam';
import { twitchProvider } from './twitch';
import { youtubeProvider } from './youtube';
import { isProviderEnvSatisfied, type IntegrationProviderDef } from './types';

const REGISTRY: Record<IntegrationProviderId, IntegrationProviderDef> = {
  twitch: twitchProvider,
  youtube: youtubeProvider,
  instagram: instagramProvider,
  reddit: redditProvider,
  steam: steamProvider,
  google_calendar: googleCalendarProvider,
  microsoft_calendar: microsoftCalendarProvider,
  generic_webhook: genericWebhookProvider,
};

/** Maps our lowercase provider id to Prisma's `IntegrationProvider` enum value. */
export const PROVIDER_ENUM_MAP: Record<IntegrationProviderId, PrismaIntegrationProvider> = {
  twitch: 'TWITCH',
  youtube: 'YOUTUBE',
  instagram: 'INSTAGRAM',
  reddit: 'REDDIT',
  steam: 'STEAM',
  google_calendar: 'GOOGLE_CALENDAR',
  microsoft_calendar: 'MICROSOFT_CALENDAR',
  generic_webhook: 'GENERIC_WEBHOOK',
};

// OPENAI/ANTHROPIC are the `ai` plugin's own connector kinds (SPEC.md §K); GITHUB/NOTION/STRIPE are retained
// Prisma enum values for historical rows only, no longer offered as connectable providers (schema.prisma) — the
// `IntegrationProvider` Prisma enum is shared, but this plugin never creates or reads connections of any of
// those five values, hence `Partial`.
const ENUM_TO_PROVIDER_ID: Partial<Record<PrismaIntegrationProvider, IntegrationProviderId>> = {
  TWITCH: 'twitch',
  YOUTUBE: 'youtube',
  INSTAGRAM: 'instagram',
  REDDIT: 'reddit',
  STEAM: 'steam',
  GOOGLE_CALENDAR: 'google_calendar',
  MICROSOFT_CALENDAR: 'microsoft_calendar',
  GENERIC_WEBHOOK: 'generic_webhook',
};

/** `undefined` for enum values this plugin doesn't own (OPENAI/ANTHROPIC — the `ai` plugin's connectors). */
export function providerIdFromEnum(value: PrismaIntegrationProvider): IntegrationProviderId | undefined {
  return ENUM_TO_PROVIDER_ID[value];
}

/** Returns the connector definition for `id`, or `undefined` for an unknown/unsupported id. */
export function getProvider(id: string): IntegrationProviderDef | undefined {
  return REGISTRY[id as IntegrationProviderId];
}

export function listProviderDefs(): IntegrationProviderDef[] {
  return INTEGRATION_PROVIDER_IDS.map((id) => REGISTRY[id]);
}

/** Per-provider availability (ARCHITECTURE.md's integrations connector spec: "clear setup page and connection status"). */
export function listProviderAvailability(env: Record<string, unknown>): IntegrationProviderInfoDto[] {
  return listProviderDefs().map((def) => ({
    id: def.id,
    name: def.name,
    kind: def.kind,
    available: isProviderEnvSatisfied(def.requiredEnv, env),
    missingEnv: def.requiredEnv.filter((key) => !env[key]),
    supportsAlerts: def.poll !== undefined && def.kind !== 'webhook',
  }));
}

export * from './types';
