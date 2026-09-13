import type { Metadata } from 'next';
import { Section } from '../../components/Section';
import { Glass } from '../../components/Glass';
import { privacyPolicy, DEFAULT_OPERATOR, DEFAULT_CONTACT_EMAIL } from '../../content/legal';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description: 'How Entrophy collects, stores, and protects data across the bot, dashboard, and website.',
};

export default function PrivacyPage() {
  const sections = privacyPolicy(DEFAULT_OPERATOR, DEFAULT_CONTACT_EMAIL);

  return (
    <Section headingLevel={1} eyebrow="Legal" title="Privacy policy">
      <Glass className="mb-8 p-5 text-sm leading-relaxed text-grey-3">
        <strong className="text-grey-6">This is a template.</strong> It describes Entrophy&apos;s default data
        handling accurately, but the operator running this deployment (currently shown as &ldquo;
        {DEFAULT_OPERATOR}&rdquo;, contact &ldquo;{DEFAULT_CONTACT_EMAIL}&rdquo;) should review it for their
        own jurisdiction and business details before relying on it as a legal document.
      </Glass>
      <div className="space-y-8">
        {sections.map((section) => (
          <div key={section.title}>
            <h3 className="text-lg font-semibold text-grey-7">{section.title}</h3>
            {section.paragraphs.map((p, i) => (
              <p key={i} className="mt-2 text-sm leading-relaxed text-grey-3">
                {p}
              </p>
            ))}
          </div>
        ))}
      </div>
    </Section>
  );
}
