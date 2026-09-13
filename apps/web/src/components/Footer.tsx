import { Logo } from './Logo';
import { siteCopy } from '../content/site';
import { supportServerUrl, GITHUB_URL } from '../lib/site';

const COLUMNS: { title: string; links: { href: string; label: string; external?: boolean }[] }[] = [
  {
    title: 'Product',
    links: [
      { href: '/features', label: 'Features & commands' },
      { href: '/enforcer', label: 'Enforcer' },
      { href: '/donate', label: 'Donate' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { href: '/privacy', label: 'Privacy policy' },
      { href: '/terms', label: 'Terms of service' },
    ],
  },
];

export function Footer() {
  const support = supportServerUrl();
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-white/10">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          <div className="col-span-2">
            <Logo />
            <p className="mt-3 max-w-xs text-sm text-grey-3">{siteCopy.footer.tagline}</p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-grey-2">{col.title}</h3>
              <ul className="mt-3 space-y-2">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <a href={link.href} className="text-sm text-grey-3 transition-colors hover:text-grey-7">
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-grey-2">Community</h3>
            <ul className="mt-3 space-y-2">
              {support && (
                <li>
                  <a
                    href={support}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-grey-3 transition-colors hover:text-grey-7"
                  >
                    Support server
                  </a>
                </li>
              )}
              <li>
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-grey-3 transition-colors hover:text-grey-7"
                >
                  GitHub
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="mt-10 border-t border-white/10 pt-6 text-xs text-grey-2">
          © {year} Pavisie. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
