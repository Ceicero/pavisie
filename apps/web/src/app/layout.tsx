import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '../components/Providers';
import { SiteChrome } from '../components/SiteChrome';
import { SITE_URL } from '../lib/site';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'Pavisie — Discord moderation you can trust', template: '%s · Pavisie' },
  description:
    'Pavisie is a modular, compliance-first Discord bot: moderation, automod, a policy-driven Enforcer, tickets, roles, leveling, and more. Never Administrator. Everything logged.',
  applicationName: 'Pavisie',
  openGraph: {
    type: 'website',
    siteName: 'Pavisie',
    title: 'Pavisie — Discord moderation you can trust',
    description:
      'A modular, compliance-first Discord bot built for gaming communities. Never Administrator. Everything logged.',
    url: SITE_URL,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pavisie — Discord moderation you can trust',
    description: 'A modular, compliance-first Discord bot built for gaming communities.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh bg-ink-0 text-grey-7 antialiased">
        <Providers>
          <SiteChrome>{children}</SiteChrome>
        </Providers>
      </body>
    </html>
  );
}
