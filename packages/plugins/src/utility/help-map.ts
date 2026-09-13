// Static top-level-command-name -> owning-plugin-id map for `/help` (ARCHITECTURE.md §7.1's command table).
// Kept deliberately ahead of what's actually implemented yet: every plugin row in §7.1 is transcribed here in
// full, so this file does not need to change again as other build stages land their commands — the coverage
// test in `__tests__/help-map.test.ts` walks `allPlugins` and asserts every *actually registered* top-level
// command name resolves to its true owning plugin via this map, which will keep passing as long as new
// commands use the names already listed in §7.1. Context-menu command names are included too (they show up
// in `application.commands` alongside slash commands with their own top-level name).
import type { PluginId } from '@pavisie/types';

/** Sentinel plugin id used when a command name isn't recognized by this map. Not a real `PluginId`. */
export const OTHER_GROUP = 'other' as const;

export const HELP_MAP: Record<string, PluginId> = {
  // admin
  setup: 'admin',
  config: 'admin',
  plugin: 'admin',
  permissions: 'admin',
  health: 'admin',
  pavisie: 'admin',

  // moderation
  mod: 'moderation',
  appeal: 'moderation',
  'Warn user': 'moderation',
  'View cases': 'moderation',

  // automod
  automod: 'automod',

  // enforcer
  enforcer: 'enforcer',
  'Flag for review': 'enforcer',

  // logging
  logs: 'logging',

  // tickets
  ticket: 'tickets',

  // roles
  roles: 'roles',
  welcome: 'roles',
  goodbye: 'roles',
  verify: 'roles',
  verification: 'roles',
  onboarding: 'roles',

  // engagement
  level: 'engagement',
  rep: 'engagement',
  starboard: 'engagement',
  tempvoice: 'engagement',

  // community
  poll: 'community',
  giveaway: 'community',
  suggest: 'community',
  suggestions: 'community',
  announce: 'community',
  remind: 'community',
  event: 'community',
  tag: 'community',
  sticky: 'community',
  channelauto: 'community',
  statschannel: 'community',
  birthday: 'community',

  // economy
  economy: 'economy',

  // gamestats
  dbd: 'gamestats',

  // utility
  help: 'utility',
  utility: 'utility',
  embed: 'utility',
  'User info': 'utility',

  // media
  music: 'media',

  // integrations
  integration: 'integrations',
  twitch: 'integrations',

  // ai
  ask: 'ai',
  summarize: 'ai',
  draft: 'ai',
  'mod-assist': 'ai',
  ai: 'ai',
};

/**
 * Resolves the owning plugin id for a top-level command name, or `OTHER_GROUP` if it isn't in `HELP_MAP`.
 * Uses `hasOwnProperty` rather than a bare `HELP_MAP[topLevelName]` lookup so a command name that happens to
 * collide with an inherited `Object.prototype` member (e.g. `"constructor"`, `"toString"`) can't accidentally
 * resolve to that inherited value instead of `OTHER_GROUP`.
 */
export function resolvePluginForCommand(topLevelName: string): PluginId | typeof OTHER_GROUP {
  return Object.prototype.hasOwnProperty.call(HELP_MAP, topLevelName) ? HELP_MAP[topLevelName] : OTHER_GROUP;
}
