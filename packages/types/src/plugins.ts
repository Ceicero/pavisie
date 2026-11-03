/** Every plugin id in the platform (see ARCHITECTURE.md §7.1). */
export type PluginId =
  | 'admin'
  | 'moderation'
  | 'automod'
  | 'enforcer'
  | 'logging'
  | 'tickets'
  | 'roles'
  | 'engagement'
  | 'community'
  | 'economy'
  | 'utility'
  | 'media'
  | 'integrations'
  | 'ai';

/** All plugin ids, in the canonical load/display order from ARCHITECTURE.md §7.1. */
export const PLUGIN_IDS: readonly PluginId[] = [
  'admin',
  'moderation',
  'automod',
  'enforcer',
  'logging',
  'tickets',
  'roles',
  'engagement',
  'community',
  'economy',
  'utility',
  'media',
  'integrations',
  'ai',
] as const;
