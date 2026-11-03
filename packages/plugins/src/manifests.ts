// Manifest-only barrel: imports every plugin's `manifest.ts` (never a plugin's `index.ts`), so this module stays
// free of discord.js runtime code beyond types/enums — the API can load it cheaply (ARCHITECTURE.md §7.1).
import { manifest as admin } from './admin/manifest';
import { manifest as moderation } from './moderation/manifest';
import { manifest as automod } from './automod/manifest';
import { manifest as enforcer } from './enforcer/manifest';
import { manifest as logging } from './logging/manifest';
import { manifest as tickets } from './tickets/manifest';
import { manifest as roles } from './roles/manifest';
import { manifest as engagement } from './engagement/manifest';
import { manifest as community } from './community/manifest';
import { manifest as economy } from './economy/manifest';
import { manifest as utility } from './utility/manifest';
import { manifest as media } from './media/manifest';
import { manifest as integrations } from './integrations/manifest';
import { manifest as ai } from './ai/manifest';
import type { PluginManifest } from './sdk';

/** Every plugin's manifest, in the canonical order from ARCHITECTURE.md §7.1. */
export const allManifests: PluginManifest[] = [
  admin,
  moderation,
  automod,
  enforcer,
  logging,
  tickets,
  roles,
  engagement,
  community,
  economy,
  utility,
  media,
  integrations,
  ai,
];
