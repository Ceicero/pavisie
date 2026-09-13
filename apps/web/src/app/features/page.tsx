import type { Metadata } from 'next';
import { Section } from '../../components/Section';
import { Glass } from '../../components/Glass';
import { Badge } from '../../components/Badge';
import { CommandTable } from '../../components/CommandTable';
import { PluginSwitcher } from '../../components/PluginSwitcher';
import { allPluginExports } from '../../lib/commands';
import { pluginCopy } from '../../content/plugins';

export const metadata: Metadata = {
  title: 'Features & commands',
  description:
    'Every Pavisie plugin, why gaming communities use it, and the full command reference — generated straight from the plugin registry.',
};

export default function FeaturesPage() {
  const plugins = allPluginExports();

  return (
    <>
      <Section
        headingLevel={1}
        eyebrow="Features & commands"
        title="Every plugin, every command, generated from the real registry"
        subtitle="This page can never drift from what the bot actually does — it's built directly from the same plugin registry the bot registers commands from."
      >
        <Glass className="mb-8 p-6">
          <p className="text-sm leading-relaxed text-grey-3">
            Every command below can be run in two ways: type <span className="font-mono font-semibold text-grey-7">+name</span> in any channel (like <span className="font-mono">+mod ban</span>) or use the <span className="font-mono">/name</span> slash-command menu. Type <span className="font-mono font-semibold text-grey-7">+help</span> in Discord to see all commands right now.
          </p>
        </Glass>
        <PluginSwitcher plugins={plugins} hrefFor={(id) => `#${id}`} ariaLabel="Jump to plugin" />
      </Section>

      <div className="mx-auto max-w-6xl space-y-16 px-6 pb-24">
        {plugins.map((plugin) => {
          const copy = pluginCopy[plugin.id];
          return (
            <article key={plugin.id} id={plugin.id} className="scroll-mt-24">
              <Glass className="p-6 sm:p-10">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-semibold tracking-tight text-grey-7">{plugin.name}</h2>
                    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-grey-3">{copy.headline}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone={plugin.defaultEnabled ? 'solid' : 'outline'}>
                      {plugin.defaultEnabled ? 'On by default' : 'Opt-in'}
                    </Badge>
                    {plugin.privilegedIntents.map((intent) => (
                      <Badge key={intent} tone="outline">
                        Needs {intent} intent
                      </Badge>
                    ))}
                  </div>
                </div>

                <h3 className="mt-8 text-sm font-semibold uppercase tracking-wider text-grey-2">
                  Why gaming communities love it
                </h3>
                <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {copy.whyGaming.map((reason) => (
                    <li key={reason} className="flex gap-2 text-sm leading-relaxed text-grey-3">
                      <span aria-hidden="true" className="text-grey-5">
                        —
                      </span>
                      {reason}
                    </li>
                  ))}
                </ul>

                <h3 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-grey-2">
                  Commands
                </h3>
                <CommandTable commands={plugin.commands} />

                <div className="mt-6">
                  <a
                    href={`/features/${plugin.id}`}
                    className="text-sm text-grey-4 underline decoration-white/20 underline-offset-4 hover:text-grey-7"
                  >
                    Full detail page for {plugin.name} →
                  </a>
                </div>
              </Glass>
            </article>
          );
        })}
      </div>
    </>
  );
}
