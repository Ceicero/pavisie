import type { Metadata } from 'next';
import { Section } from '../../components/Section';
import { Glass } from '../../components/Glass';
import { Badge } from '../../components/Badge';
import { siteCopy } from '../../content/site';

export const metadata: Metadata = {
  title: 'Staff roles & permissions',
  description:
    "Pavisie's four permission tiers, what each tier can do, and how to attach your own Discord roles to each tier.",
};

export default function StaffRolesPage() {
  const { staffRoles: copy } = siteCopy;

  return (
    <>
      <Section headingLevel={1} eyebrow={copy.eyebrow} title={copy.title} subtitle={copy.intro} />

      <Section eyebrow="Permission tiers" title="What each tier can actually do">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {copy.tiers.map((tier, index) => (
            <article key={tier.name}>
              <Glass className="flex h-full flex-col p-6 sm:p-8">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-lg font-semibold text-grey-7">{tier.name}</h3>
                    <p className="text-sm text-grey-4">{tier.label}</p>
                  </div>
                  <Badge tone="outline">Tier {index + 1} of {copy.tiers.length}</Badge>
                </div>

                <p className="mb-6 text-sm leading-relaxed text-grey-3">{tier.description}</p>

                <div className="mb-6 flex-1">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-grey-3">
                    Can run
                  </p>
                  <ul className="space-y-2">
                    {tier.commands.map((cmd, i) => (
                      <li key={i} className="text-sm leading-relaxed text-grey-3">
                        <span className="font-mono text-grey-5">{cmd}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {tier.detail && (
                  <p className="border-t border-white/10 pt-4 text-sm italic leading-relaxed text-grey-3">
                    {tier.detail}
                  </p>
                )}
              </Glass>
            </article>
          ))}
        </div>

        <Glass className="mt-6 p-6 sm:p-8">
          <p className="text-sm leading-relaxed text-grey-3">
            <span className="font-semibold text-grey-7">Owner tier:</span> The Discord server owner is always
            the Owner tier. They have full access to every command, every tier, and every feature, and cannot be
            locked out. No role attachment needed.
          </p>
        </Glass>
      </Section>

      <Section eyebrow="Setup" title={copy.setupTitle} subtitle={copy.setupIntro}>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {copy.setupMethods.map((method, idx) => (
            <Glass key={idx} className="p-6 sm:p-8">
              <h3 className="mb-2 text-base font-semibold text-grey-7">{method.method}</h3>
              <p className="mb-4 text-sm leading-relaxed text-grey-3">{method.description}</p>
              <div className="space-y-2 rounded-lg bg-white/[0.03] p-4">
                {method.commands.map((cmd, i) => (
                  <code key={i} className="block font-mono text-sm text-grey-4">
                    {cmd}
                  </code>
                ))}
              </div>
            </Glass>
          ))}
        </div>

        <Glass className="mt-6 p-6 sm:p-8">
          <p className="text-sm leading-relaxed text-grey-3">
            <span className="font-semibold text-grey-7">Verify your setup:</span> {copy.setupVerify}
          </p>
        </Glass>
      </Section>

      <Section eyebrow="Remember" title="A few key points">
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[
            'Roles are your own. Pavisie does not create roles — it points your existing Discord roles at permission tiers.',
            'No role = member tier. Until you attach a role to a tier, only the server owner has staff powers.',
            'Least privilege. Members can only affect themselves or things they own. Managers must hold a staff role to affect other users.',
            'Every command, both ways. Every command works as +command in chat or /command in the slash menu.',
            'Audit trail. Config changes write to the audit log, and +permissions shows the full permission picture.',
            'Always reversible. Change role assignments or plugin settings anytime — no data is lost.',
          ].map((point, i) => (
            <li key={i}>
              <Glass className="h-full p-5 text-sm leading-relaxed text-grey-3">
                {point}
              </Glass>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
