// Builds the `/help` catalog: every registered application command, flattened (subcommand groups/subcommands
// included) into `/full name` + description entries, grouped by owning plugin via `help-map.ts`.
//
// Implementation note (deviation from this task's literal wording): the spec for this plugin says to "build
// the catalog at onLoad from ctx.client.application.commands (fetch)". That's not actually possible — per
// ARCHITECTURE.md §9 / apps/bot/src/index.ts, `loadPlugins()` (and therefore every plugin's `onLoad`) runs
// *before* `client.login()`, so `ctx.client.application` is still `null` at `onLoad` time; fetching then would
// always fail. Instead this module fetches lazily (first `/help` call after boot, or after the cache expires)
// and caches the result in-process for `CATALOG_TTL_MS`, which is both correct (the client is always logged
// in by the time a command executes) and self-healing (a failed fetch just gets retried on the next call
// rather than leaving `/help` permanently empty for the process lifetime).
import { ApplicationCommandType, type ApplicationCommandOptionData, type Client } from 'discord.js';
import type { PluginId } from '@pavisie/types';
import { allManifests } from '../manifests';
import { HELP_HINT_SUFFIX } from '../sdk/help-hint';
import { OTHER_GROUP, resolvePluginForCommand } from './help-map';

export interface CatalogEntry {
  /** e.g. "/mod warn", "/help", "User info" (context menu commands have no leading slash). */
  fullName: string;
  description: string;
}

export interface CommandCatalog {
  byPlugin: Map<PluginId | typeof OTHER_GROUP, CatalogEntry[]>;
  fetchedAt: number;
  /** True if this catalog is the manifest-only fallback (the live `application.commands` fetch failed or returned nothing). */
  degraded: boolean;
}

const CATALOG_TTL_MS = 10 * 60 * 1000;

let cached: CommandCatalog | null = null;

interface FetchedOption {
  name: string;
  description?: string;
  type: number;
  options?: readonly FetchedOption[];
}

/**
 * Removes the registration-time `+help` hint from a description before it is listed inside `/help` itself.
 * `registry.commandsJson()` appends the hint to every top-level command so it shows in Discord's command
 * picker, and this catalog reads those live descriptions back — so without this, every top-level row in the
 * help menu would end with a redundant "• +help" while its subcommands did not.
 */
function stripHelpHint(description: string): string {
  return description.endsWith(HELP_HINT_SUFFIX) ? description.slice(0, -HELP_HINT_SUFFIX.length) : description;
}

function flatten(
  name: string,
  description: string,
  options: readonly FetchedOption[] | undefined,
  prefix: string,
): CatalogEntry[] {
  const fullName = `${prefix}${name}`;
  const subOptions = (options ?? []).filter(
    (opt) => opt.type === 1 /* Subcommand */ || opt.type === 2 /* SubcommandGroup */,
  );

  if (subOptions.length === 0) {
    return [{ fullName, description: stripHelpHint(description) }];
  }

  const entries: CatalogEntry[] = [];
  for (const opt of subOptions) {
    if (opt.type === 2 /* SubcommandGroup */) {
      entries.push(...flatten(opt.name, opt.description ?? description, opt.options, `${fullName} `));
    } else {
      entries.push({
        fullName: `${fullName} ${opt.name}`,
        description: stripHelpHint(opt.description ?? description),
      });
    }
  }
  return entries;
}

/** Manifest-only fallback catalog (one entry per plugin, using its name/description) — used when the live fetch is unavailable. */
function buildManifestFallback(): CommandCatalog {
  const byPlugin = new Map<PluginId | typeof OTHER_GROUP, CatalogEntry[]>();
  for (const manifest of allManifests) {
    byPlugin.set(manifest.id, [{ fullName: `/${manifest.id}`, description: manifest.description }]);
  }
  return { byPlugin, fetchedAt: Date.now(), degraded: true };
}

/**
 * Returns the cached catalog if it's still fresh, otherwise fetches every global + guild application command
 * from Discord, flattens subcommands/groups, and groups the results by owning plugin. Falls back to a
 * manifest-only catalog (one line per plugin) if the client isn't ready yet or the fetch fails.
 */
export async function getCommandCatalog(
  client: Client,
  guildId: string,
  force = false,
): Promise<CommandCatalog> {
  if (!force && cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return cached;
  }

  if (!client.isReady() || !client.application) {
    return cached ?? buildManifestFallback();
  }

  try {
    const [globalCommands, guildCommands] = await Promise.all([
      client.application.commands.fetch(),
      client.application.commands.fetch({ guildId }).catch(() => null),
    ]);

    const merged = new Map<
      string,
      {
        name: string;
        description: string;
        type: ApplicationCommandType;
        options: readonly ApplicationCommandOptionData[];
      }
    >();
    for (const cmd of globalCommands.values()) {
      merged.set(cmd.name, {
        name: cmd.name,
        description: cmd.description,
        type: cmd.type,
        options: (cmd.options ?? []) as readonly ApplicationCommandOptionData[],
      });
    }
    if (guildCommands) {
      for (const cmd of guildCommands.values()) {
        merged.set(cmd.name, {
          name: cmd.name,
          description: cmd.description,
          type: cmd.type,
          options: (cmd.options ?? []) as readonly ApplicationCommandOptionData[],
        });
      }
    }

    if (merged.size === 0) {
      return cached ?? buildManifestFallback();
    }

    const byPlugin = new Map<PluginId | typeof OTHER_GROUP, CatalogEntry[]>();
    for (const cmd of merged.values()) {
      const pluginId = resolvePluginForCommand(cmd.name);
      const isContextMenu =
        cmd.type === ApplicationCommandType.User || cmd.type === ApplicationCommandType.Message;
      const entries = isContextMenu
        ? [{ fullName: cmd.name, description: cmd.description || '(context menu command)' }]
        : flatten(cmd.name, cmd.description, cmd.options as unknown as FetchedOption[] | undefined, '/');

      const existing = byPlugin.get(pluginId) ?? [];
      existing.push(...entries);
      byPlugin.set(pluginId, existing);
    }

    cached = { byPlugin, fetchedAt: Date.now(), degraded: false };
    return cached;
  } catch {
    return cached ?? buildManifestFallback();
  }
}

/** Clears the in-process catalog cache (used by tests). */
export function resetCommandCatalogCache(): void {
  cached = null;
}
