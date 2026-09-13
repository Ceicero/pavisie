import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Tests that icon-only buttons in dashboard components have accessible aria-labels.
 * Screen readers need descriptive labels when only an icon is shown.
 */

describe('Dashboard icon-only buttons — accessibility', () => {
  it('onboarding-tab trash button has aria-label', () => {
    const filePath = fileURLToPath(
      new URL('../src/components/dashboard/roles/onboarding-tab.tsx', import.meta.url),
    );
    const source = readFileSync(filePath, 'utf8');

    // Find the trash button (looking for the pattern of Button + aria-label near Trash2 icon)
    const trashButtonMatch = source.match(/<Button[\s\S]*?aria-label="Remove step"[\s\S]*?<Trash2/);
    expect(trashButtonMatch).toBeTruthy();
  });

  it('verification-tab trash button has aria-label', () => {
    const filePath = fileURLToPath(
      new URL('../src/components/dashboard/roles/verification-tab.tsx', import.meta.url),
    );
    const source = readFileSync(filePath, 'utf8');

    // Find the trash button (looking for the pattern of Button + aria-label near Trash2 icon)
    const trashButtonMatch = source.match(/<Button[\s\S]*?aria-label="Remove question"[\s\S]*?<Trash2/);
    expect(trashButtonMatch).toBeTruthy();
  });
});
