import Link from 'next/link';
import { Badge } from './Badge';
import type { ExportedPlugin } from '../lib/commands';
import { countLeafCommands } from '../lib/commands';
import type { PluginCopy } from '../content/plugins';

interface PluginCardProps {
  plugin: ExportedPlugin;
  copy: PluginCopy;
}

export function PluginCard({ plugin, copy }: PluginCardProps) {
  const commandCount = countLeafCommands(plugin);

  return (
    <Link
      href={`/features/${plugin.id}`}
      className="glass group flex flex-col gap-3 p-6 transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-grey-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-grey-7">{plugin.name}</h3>
        <Badge tone={plugin.defaultEnabled ? 'solid' : 'outline'}>
          {plugin.defaultEnabled ? 'On by default' : 'Opt-in'}
        </Badge>
      </div>
      <p className="text-sm leading-relaxed text-grey-3">{copy.headline}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {copy.highlights.slice(0, 3).map((h) => (
          <Badge key={h}>{h}</Badge>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between pt-3 text-xs text-grey-3">
        <span>
          {commandCount} command{commandCount === 1 ? '' : 's'}
        </span>
        <span className="text-grey-4 transition-transform group-hover:translate-x-0.5">View details →</span>
      </div>
    </Link>
  );
}
