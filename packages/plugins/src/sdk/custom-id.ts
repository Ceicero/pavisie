import { CUSTOM_ID_MAX } from '@pavisie/core';
import type { PluginId } from '@pavisie/types';

export interface ParsedCustomId {
  pluginId: string;
  action: string;
  args: string[];
}

/** Builds a `<pluginId>:<action>:<arg>...` component custom id. Throws if the result exceeds Discord's 100-char limit. */
export function buildCustomId(pluginId: PluginId, action: string, ...args: (string | number)[]): string {
  const parts = [pluginId, action, ...args.map(String)];
  const customId = parts.join(':');
  if (customId.length > CUSTOM_ID_MAX) {
    throw new Error(`Custom id exceeds ${CUSTOM_ID_MAX} characters (${customId.length}): "${customId}"`);
  }
  return customId;
}

/** Parses a `<pluginId>:<action>:<arg>...` component custom id back into its parts. */
export function parseCustomId(customId: string): ParsedCustomId {
  const [pluginId, action, ...args] = customId.split(':');
  return { pluginId: pluginId ?? '', action: action ?? '', args };
}
