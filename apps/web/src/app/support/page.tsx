import type { Metadata } from 'next';
import { Section } from '../../components/Section';
import { Glass } from '../../components/Glass';
import { ButtonLink } from '../../components/Button';
import { supportServerUrl } from '../../lib/site';

export const metadata: Metadata = {
  title: 'Support',
  description:
    'Get help with Pavisie: join the community Discord server for setup help, bug reports, and feature requests.',
};

const USE_CASES = [
  {
    title: 'Setup help',
    body: "Stuck inviting the bot, wiring up a plugin, or configuring a policy? Ask in the server and describe what you're trying to do and what happened instead.",
  },
  {
    title: 'Bug reports',
    body: "Something not behaving the way the docs say it should? Note which plugin, what you expected, and what actually happened — that's the fastest path to a fix.",
  },
  {
    title: 'Feature requests',
    body: 'Missing something your server needs? Suggest it. The roadmap is shaped by what real communities running Pavisie actually ask for.',
  },
];

export default function SupportPage() {
  const support = supportServerUrl();

  return (
    <>
      <Section
        headingLevel={1}
        eyebrow="Support"
        title="Get help from the community"
        subtitle="Pavisie is community-run, and the Discord server is the main place to get help — setup questions, bug reports, and feature requests all land there. It's a new server, so response times will vary."
      >
        {support ? (
          <ButtonLink href={support} external variant="primary" size="lg">
            Join the support server
          </ButtonLink>
        ) : (
          <Glass className="max-w-lg p-6 text-sm leading-relaxed text-grey-3">
            The support server isn&apos;t linked for this deployment yet.
          </Glass>
        )}
      </Section>

      <Section eyebrow="What it's for" title="What to bring to the server">
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-3" aria-label="What the support server is for">
          {USE_CASES.map((item) => (
            <li key={item.title}>
              <Glass className="h-full p-6">
                <h3 className="text-base font-semibold text-grey-7">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-grey-3">{item.body}</p>
              </Glass>
            </li>
          ))}
        </ul>
      </Section>

      <Section eyebrow="Somewhere else to look" title="Already know what you need?">
        <div className="flex flex-wrap gap-4">
          <ButtonLink href="/dashboard" variant="outline" size="md">
            Open the dashboard
          </ButtonLink>
          <ButtonLink href="/features" variant="outline" size="md">
            Browse commands & features
          </ButtonLink>
        </div>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-grey-3">
          The dashboard is where you configure plugins, moderation, and settings for your own server. The
          features page is the full command reference, generated straight from the plugin registry, if you
          just need to look something up.
        </p>
      </Section>
    </>
  );
}
