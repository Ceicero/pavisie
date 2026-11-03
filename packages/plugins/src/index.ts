import admin from './admin';
import moderation from './moderation';
import automod from './automod';
import enforcer from './enforcer';
import logging from './logging';
import tickets from './tickets';
import roles from './roles';
import engagement from './engagement';
import community from './community';
import economy from './economy';
import utility from './utility';
import media from './media';
import integrations from './integrations';
import ai from './ai';
import type { Plugin } from './sdk';

/** Every plugin, in the canonical load/display order from ARCHITECTURE.md §7.1. */
export const allPlugins: Plugin[] = [
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

export { allManifests } from './manifests';
export * from './sdk';
