import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Tests that all public marketing pages have exactly one top-level (h1) heading.
 * The Section component renders headings dynamically, so we check:
 * 1. The first Section on each page uses headingLevel={1}
 * 2. The homepage has an explicit <h1> tag (it predates Section)
 * Dashboard pages are intentionally excluded (they live behind the session gate).
 */

const PUBLIC_PAGES_WITH_SECTION = [
  { path: 'src/app/features/page.tsx', name: 'features' },
  { path: 'src/app/features/[pluginId]/page.tsx', name: 'plugin detail' },
  { path: 'src/app/enforcer/page.tsx', name: 'enforcer' },
  { path: 'src/app/donate/page.tsx', name: 'donate' },
  { path: 'src/app/support/page.tsx', name: 'support' },
  { path: 'src/app/privacy/page.tsx', name: 'privacy' },
  { path: 'src/app/terms/page.tsx', name: 'terms' },
  { path: 'src/app/staff-roles/page.tsx', name: 'staff roles' },
];

describe('Public marketing pages — heading accessibility', () => {
  it('homepage has exactly one top-level (h1) heading', () => {
    const filePath = fileURLToPath(new URL('../src/app/page.tsx', import.meta.url));
    const source = readFileSync(filePath, 'utf8');

    // The homepage has an explicit <h1> tag (not via Section)
    const h1Count = (source.match(/<h1[\s>]/g) || []).length;
    expect(h1Count).toBe(1);
  });

  PUBLIC_PAGES_WITH_SECTION.forEach(({ path, name }) => {
    it(`${name} page's first Section uses headingLevel={1}`, () => {
      const filePath = fileURLToPath(new URL(`../${path}`, import.meta.url));
      const source = readFileSync(filePath, 'utf8');

      // Find the first <Section opening tag that includes headingLevel={1}
      // The pattern looks for: <Section ... headingLevel={1} ... (title or subtitle)
      const hasFirstSectionWithH1 = /<Section[\s\S]*?headingLevel=\{1\}[\s\S]*?(title|subtitle)=/.test(
        source,
      );

      expect(hasFirstSectionWithH1).toBe(true);
    });
  });
});
