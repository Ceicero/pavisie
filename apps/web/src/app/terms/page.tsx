import type { Metadata } from 'next';
import { Section } from '../../components/Section';
import { Glass } from '../../components/Glass';
import { termsOfService, DEFAULT_OPERATOR, DEFAULT_CONTACT_EMAIL } from '../../content/legal';

export const metadata: Metadata = {
  title: 'Terms of service',
  description: 'The terms governing use of the Entrophy bot, dashboard, and website.',
};

export default function TermsPage() {
  const sections = termsOfService(DEFAULT_OPERATOR, DEFAULT_CONTACT_EMAIL);

  return (
    <Section headingLevel={1} eyebrow="Legal" title="Terms of service">
      <Glass className="mb-8 p-5 text-sm leading-relaxed text-grey-3">
        <strong className="text-grey-6">This is a template.</strong> It reflects Entrophy&apos;s default
        behavior (no wagering, non-refundable donations, etc.) but the operator running this deployment
        (currently shown as &ldquo;{DEFAULT_OPERATOR}&rdquo;, contact &ldquo;{DEFAULT_CONTACT_EMAIL}&rdquo;)
        should review it before relying on it as a legal document.
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
