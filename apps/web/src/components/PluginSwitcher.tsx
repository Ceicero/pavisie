import { clsx } from 'clsx';
import type { ExportedPlugin } from '../lib/commands';

interface PluginSwitcherProps {
  plugins: Pick<ExportedPlugin, 'id' | 'name'>[];
  /** Plugin id to visually mark as the current one. Omit on the index page, where nothing is "active". */
  activeId?: string;
  /** Builds the href for a plugin pill. Defaults to linking straight to that plugin's detail page — pass
   * `(id) => \`#${id}\`` on the index page, where the pills jump to an in-page anchor instead. */
  hrefFor?: (id: string) => string;
  /** aria-label for the nav landmark — the index page uses these pills to jump within the page, detail pages
   * use them to switch to a different plugin's page, so the accessible name differs between the two. */
  ariaLabel?: string;
  className?: string;
}

/** Pill row of every plugin, shared between the `/features` index (jumps to an in-page anchor) and each
 * `/features/[pluginId]` detail page (links to that plugin's own page, current plugin marked active) so
 * someone can hop between plugins without going back to the index first. */
export function PluginSwitcher({
  plugins,
  activeId,
  hrefFor,
  ariaLabel = 'Jump to plugin',
  className,
}: PluginSwitcherProps) {
  const toHref = hrefFor ?? ((id: string) => `/features/${id}`);

  return (
    <nav aria-label={ariaLabel} className={clsx('flex flex-wrap gap-2', className)}>
      {plugins.map((plugin) => {
        const isActive = plugin.id === activeId;
        return (
          <a
            key={plugin.id}
            href={toHref(plugin.id)}
            aria-current={isActive ? 'page' : undefined}
            className={clsx(
              'rounded-full border px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-5',
              isActive
                ? 'border-transparent bg-grey-7 text-ink-0'
                : 'border-white/10 text-grey-3 hover:border-white/25 hover:text-grey-7',
            )}
          >
            {plugin.name}
          </a>
        );
      })}
    </nav>
  );
}
