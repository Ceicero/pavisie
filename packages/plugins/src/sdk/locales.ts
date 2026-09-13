import { registerLocaleBundle, t as coreT } from '@pavisie/core';
import type { PluginId } from '@pavisie/types';

export type PluginLocaleBundles = Record<string, Record<string, unknown>>;
export type BoundTFunction = (key: string, vars?: Record<string, string | number>, locale?: string) => string;

/**
 * Registers one locale bundle per locale for `pluginId` (namespace = the plugin id) and returns a `t` function
 * scoped to it: `t(key)` first tries the plugin's own bundle (`<pluginId>.<key>`), then falls back to the core
 * bundle (`<key>`) for shared strings like `errors.missing_staff_level` or `errors.hierarchy.*`.
 */
export function registerPluginLocales(pluginId: PluginId, bundles: PluginLocaleBundles): BoundTFunction {
  for (const [locale, bundle] of Object.entries(bundles)) {
    registerLocaleBundle(pluginId, locale, bundle);
  }

  return function boundT(key: string, vars?: Record<string, string | number>, locale = 'en'): string {
    const pluginKey = `${pluginId}.${key}`;
    const viaPlugin = coreT(pluginKey, vars, locale);
    if (viaPlugin !== pluginKey) {
      return viaPlugin;
    }
    return coreT(key, vars, locale);
  };
}
