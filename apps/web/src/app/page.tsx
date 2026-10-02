import { ShieldCheck, ScrollText, EyeOff, Gauge, Twitch, Bot, Gift, Coins, Link2 } from 'lucide-react';
import { Section } from '../components/Section';
import { Glass } from '../components/Glass';
import { Badge } from '../components/Badge';
import { ButtonLink } from '../components/Button';
import { PluginCard } from '../components/PluginCard';
import { Logo } from '../components/Logo';
import { siteCopy } from '../content/site';
import { pluginCopy } from '../content/plugins';
import { allPluginExports, totalCommandCount } from '../lib/commands';
import { inviteUrl } from '../lib/site';
import { creatorLoginUrl } from '../lib/creator/login-url';

const TRUST_ICONS = [ShieldCheck, EyeOff, ScrollText, Gauge];
const STREAMER_ICONS = [Bot, Gift, Coins, Link2];

export default function HomePage() {
  const plugins = allPluginExports();
  const invite = inviteUrl();
  const commandCount = totalCommandCount();
  const twitchLogin = creatorLoginUrl('twitch');

  return (
    <>
      {/* Hero */}
      <Section className="pb-12 pt-20 sm:pt-28" as="div">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-8 flex justify-center">
            <Logo imageSize={64} withWordmark={false} />
          </div>
          <Badge tone="outline" className="mb-6">
            Prefix: {siteCopy.prefix.symbol} · {plugins.length} modular plugins · {commandCount}+ commands ·
            never Administrator
          </Badge>
          <h1 className="text-4xl font-semibold tracking-tight text-grey-7 sm:text-6xl">
            {siteCopy.heroTitle}
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-grey-3">{siteCopy.heroSubtitle}</p>

          {/* Two entry points, side by side on desktop and stacked on mobile. */}
          <div className="mt-10 grid grid-cols-1 gap-4 text-left sm:grid-cols-2">
            <Glass className="flex flex-col p-6">
              <h2 className="text-lg font-semibold text-grey-7">For Discord servers</h2>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-grey-3">
                Moderation, the Enforcer, tickets, roles and more, inside your server.
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                {invite ? (
                  <ButtonLink href={invite} external variant="primary" size="md">
                    Add to Discord
                  </ButtonLink>
                ) : (
                  <ButtonLink href="/features" variant="primary" size="md">
                    Explore features
                  </ButtonLink>
                )}
                <ButtonLink href="/dashboard" variant="outline" size="md">
                  Open dashboard
                </ButtonLink>
              </div>
            </Glass>
            <Glass className="flex flex-col p-6">
              <h2 className="text-lg font-semibold text-grey-7">{siteCopy.streamers.hero.title}</h2>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-grey-3">{siteCopy.streamers.hero.body}</p>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                {/* `target="_self"` overrides ButtonLink's new-tab default for absolute URLs: sign-in is a same-tab redirect. */}
                <ButtonLink
                  href={twitchLogin}
                  target="_self"
                  variant="outline"
                  size="md"
                  icon={<Twitch className="h-4 w-4" aria-hidden="true" />}
                >
                  Sign in with Twitch
                </ButtonLink>
                <ButtonLink href="#streamers" variant="ghost" size="md">
                  What you get
                </ButtonLink>
              </div>
            </Glass>
          </div>

          {/* Start here: +help */}
          <Glass className="mt-12 inline-block p-6 sm:p-8">
            <p className="font-mono text-2xl font-semibold text-grey-7 sm:text-3xl">+help</p>
            <p className="mt-3 text-sm leading-relaxed text-grey-3">Type it in any channel. Every command also works as a / slash command.</p>
          </Glass>
        </div>
      </Section>

      {/* Feature overview grid */}
      <Section
        id="features"
        eyebrow="Everything, opt-in"
        title="One bot, every module you actually need"
        subtitle="Every plugin can be enabled or disabled per server. Nothing here is forced on you, and nothing here asks for the Administrator permission."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plugins.map((plugin) => (
            <PluginCard key={plugin.id} plugin={plugin} copy={pluginCopy[plugin.id]} />
          ))}
        </div>
        <div className="mt-8 text-center">
          <ButtonLink href="/features" variant="ghost">
            See the full command reference →
          </ButtonLink>
        </div>
      </Section>

      {/* For streamers */}
      <Section
        id="streamers"
        eyebrow={siteCopy.streamers.eyebrow}
        title={siteCopy.streamers.title}
        subtitle={siteCopy.streamers.intro}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {siteCopy.streamers.features.map((feature, i) => {
            const Icon = STREAMER_ICONS[i % STREAMER_ICONS.length];
            return (
              <Glass key={feature.title} className="flex gap-4 p-6">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-grey-4" aria-hidden="true" />
                <div>
                  <h3 className="text-base font-semibold text-grey-7">{feature.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-grey-3">{feature.body}</p>
                </div>
              </Glass>
            );
          })}
        </div>
        <Glass className="mt-4 flex flex-col gap-6 p-6 sm:p-8 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-base font-semibold text-grey-7">How to start</h3>
            <ol className="mt-2 list-inside list-decimal space-y-1 text-sm leading-relaxed text-grey-3">
              {siteCopy.streamers.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-grey-4">{siteCopy.streamers.comingSoon}</p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-2 md:items-end">
            <ButtonLink
              href={twitchLogin}
              target="_self"
              variant="primary"
              size="lg"
              icon={<Twitch className="h-5 w-5" aria-hidden="true" />}
            >
              Sign in with Twitch
            </ButtonLink>
            <p className="max-w-xs text-xs text-grey-4 md:text-right">{siteCopy.streamers.signInNote}</p>
          </div>
        </Glass>
      </Section>

      {/* Prefix and getting started */}
      <Section
        eyebrow={siteCopy.prefix.eyebrow}
        title={siteCopy.prefix.title}
        subtitle={siteCopy.prefix.body}
      >
        <div className="space-y-2">
          {siteCopy.prefix.examples.map((example) => (
            <Glass key={example.command} className="p-4 sm:p-6">
              <p className="font-mono text-sm font-semibold text-grey-7 sm:text-base">{example.command}</p>
              <p className="mt-1 text-xs text-grey-4 sm:text-sm">{example.label}</p>
            </Glass>
          ))}
        </div>
      </Section>

      {/* Why gaming communities */}
      <Section
        eyebrow="Made for game servers"
        title={siteCopy.whyGaming.title}
        subtitle={siteCopy.whyGaming.intro}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {siteCopy.whyGaming.points.map((point) => (
            <Glass key={point.title} className="p-6">
              <h3 className="text-base font-semibold text-grey-7">{point.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-grey-3">{point.body}</p>
            </Glass>
          ))}
        </div>
      </Section>

      {/* Enforcer teaser */}
      <Section
        eyebrow="Admin Enforcer"
        title="Flag it. Review it. Decide. It's all bookkept."
        subtitle="Enforcer flags possible policy violations, shows a moderator the exact chat context, and executes their decision — so staff never have to confront a player directly. Every flag and every decision lands in a read-only ledger."
      >
        <Glass className="flex flex-col items-start gap-6 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm text-grey-3">
              Policy-driven, hands-off moderation with a full appeal trail — built for communities that need
              to show their moderation is fair.
            </p>
          </div>
          <ButtonLink href="/enforcer" variant="outline" className="shrink-0">
            See how it works →
          </ButtonLink>
        </Glass>
      </Section>

      {/* Trust & compliance */}
      <Section eyebrow="The moat" title={siteCopy.trust.title} subtitle={siteCopy.trust.intro}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {siteCopy.trust.points.map((point, i) => {
            const Icon = TRUST_ICONS[i % TRUST_ICONS.length];
            return (
              <Glass key={point.title} className="flex gap-4 p-6">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-grey-4" aria-hidden="true" />
                <div>
                  <h3 className="text-base font-semibold text-grey-7">{point.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-grey-3">{point.body}</p>
                </div>
              </Glass>
            );
          })}
        </div>
      </Section>

      {/* Donate CTA */}
      <Section as="div">
        <Glass className="flex flex-col items-center gap-6 p-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-grey-7">{siteCopy.donateCta.title}</h2>
          <p className="max-w-xl text-sm leading-relaxed text-grey-3">{siteCopy.donateCta.body}</p>
          <ButtonLink href="/donate" variant="primary" size="lg">
            Donate
          </ButtonLink>
        </Glass>
      </Section>
    </>
  );
}
