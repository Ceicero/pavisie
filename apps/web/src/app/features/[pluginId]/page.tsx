import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Section } from '../../../components/Section';
import { Glass } from '../../../components/Glass';
import { Badge } from '../../../components/Badge';
import { CommandTable } from '../../../components/CommandTable';
import { ButtonLink } from '../../../components/Button';
import { PluginSwitcher } from '../../../components/PluginSwitcher';
import { allPluginExports, getPluginExport } from '../../../lib/commands';
import { pluginCopy } from '../../../content/plugins';

interface PageProps {
  params: Promise<{ pluginId: string }>;
}

export function generateStaticParams() {
  return allPluginExports().map((plugin) => ({ pluginId: plugin.id }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { pluginId } = await params;
  const plugin = getPluginExport(pluginId);
  if (!plugin) return {};
  const copy = pluginCopy[plugin.id];
  return {
    title: plugin.name,
    description: copy.headline,
  };
}

export default async function PluginDetailPage({ params }: PageProps) {
  const { pluginId } = await params;
  const plugin = getPluginExport(pluginId);
  if (!plugin) notFound();
  const copy = pluginCopy[plugin.id];
  const plugins = allPluginExports();

  return (
    <>
      <div className="mx-auto max-w-6xl px-6 pb-6 pt-10 sm:pb-8 sm:pt-14">
        <a
          href="/features"
          className="text-sm text-grey-4 underline decoration-white/20 underline-offset-4 hover:text-grey-7"
        >
          ← All features &amp; commands
        </a>
        <div className="mt-4">
          <PluginSwitcher plugins={plugins} activeId={plugin.id} ariaLabel="Switch to another plugin" />
        </div>
      </div>

      <Section
        headingLevel={1}
        eyebrow={plugin.category}
        title={plugin.name}
        subtitle={plugin.description}
        className="pt-0 sm:pt-0"
      >
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={plugin.defaultEnabled ? 'solid' : 'outline'}>
            {plugin.defaultEnabled ? 'Enabled by default' : 'Disabled by default (opt-in)'}
          </Badge>
          {plugin.privilegedIntents.length > 0 ? (
            plugin.privilegedIntents.map((intent) => (
              <Badge key={intent} tone="outline">
                Requires the {intent} privileged intent
              </Badge>
            ))
          ) : (
            <Badge tone="outline">No privileged intents required</Badge>
          )}
        </div>

        <Glass className="mt-8 p-6 sm:p-8">
          <h3 className="text-lg font-semibold text-grey-7">{copy.headline}</h3>
          <h3 className="mt-6 text-sm font-semibold uppercase tracking-wider text-grey-2">
            Why gaming communities love it
          </h3>
          <ul className="mt-3 space-y-2">
            {copy.whyGaming.map((reason) => (
              <li key={reason} className="flex gap-2 text-sm leading-relaxed text-grey-3">
                <span aria-hidden="true" className="text-grey-5">
                  —
                </span>
                {reason}
              </li>
            ))}
          </ul>
        </Glass>

        <h3 className="mb-3 mt-10 text-sm font-semibold uppercase tracking-wider text-grey-2">
          Full command reference
        </h3>
        <CommandTable commands={plugin.commands} />

        <div className="mt-10 flex flex-wrap gap-3">
          <ButtonLink href="/features" variant="ghost">
            ← All features
          </ButtonLink>
          <ButtonLink href="/enforcer" variant="ghost">
            Admin Enforcer spotlight →
          </ButtonLink>
        </div>
      </Section>
    </>
  );
}
