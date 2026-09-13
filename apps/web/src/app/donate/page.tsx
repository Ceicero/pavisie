import type { Metadata } from 'next';
import { Section } from '../../components/Section';
import { Glass } from '../../components/Glass';
import { ButtonLink } from '../../components/Button';
import { fetchDonationConfig } from '../../lib/donations';

export const metadata: Metadata = {
  title: 'Donate',
  description: "Support Pavisie's hosting and development with a one-time donation via Ko-fi.",
};

// Fetched at request time (never at build time) — donations availability depends on whether KOFI_URL is
// configured, which can change without a rebuild of this site.
export const dynamic = 'force-dynamic';

export default async function DonatePage() {
  const config = await fetchDonationConfig();

  return (
    <Section
      headingLevel={1}
      eyebrow="Donate"
      title="Help keep Pavisie running"
      subtitle="Pavisie is community-run. Donations fund hosting and development — one-time, non-refundable, and they grant no perks or in-game advantages."
    >
      <div className="mx-auto max-w-lg">
        <Glass className="p-6 sm:p-8">
          {config.enabled && config.kofiUrl ? (
            <>
              <p className="text-sm leading-relaxed text-grey-3">
                Support us on Ko-fi to help fund hosting, development, and new features. Your donations go
                directly toward keeping Pavisie running.
              </p>
              <ButtonLink
                href={config.kofiUrl}
                external
                variant="primary"
                size="lg"
                className="mt-6 w-full text-center"
              >
                Donate on Ko-fi
              </ButtonLink>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-grey-7">Donations aren&apos;t set up</h2>
              <p className="mt-3 text-sm leading-relaxed text-grey-3">
                Donations aren&apos;t configured on this deployment right now. Check back later, or reach out
                through the support server if you&apos;d like to help another way.
              </p>
            </>
          )}
          <p className="mt-4 text-xs leading-relaxed text-grey-3">
            Donations are one-time, non-refundable, grant no perks or in-game advantages, and are not
            tax-deductible unless stated otherwise.
          </p>
        </Glass>
      </div>
    </Section>
  );
}
