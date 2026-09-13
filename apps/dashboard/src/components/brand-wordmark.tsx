'use client';

import { useState } from 'react';
import brand from '../data/brand.json';

/**
 * Sidebar brand mark: the skull logo synced from `assets/brand/` (ARCHITECTURE.md §22) into
 * `public/brand/pavisie-skull.png` by `scripts/sync-brand.mjs`. Reads the sync-generated `src/data/brand.json`
 * (same pattern as the web app's `Logo` component) for the logo path known at build time, and additionally hides
 * the `<img>` on a runtime 404 (belt-and-braces — e.g. a stale build artifact) via `onError`, falling back to a
 * plain text wordmark either way.
 */
export function BrandWordmark() {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(brand.logo) && !imageFailed;

  if (!showImage) {
    return <span className="text-sm font-semibold tracking-wide text-foreground">Pavisie</span>;
  }

  return (
    // Plain <img>, not next/image: the brand asset is synced at build/dev time (or absent) by scripts/sync-brand.mjs,
    // so its dimensions/existence aren't known statically the way next/image requires.
    <img
      src={brand.logo ?? undefined}
      alt="Pavisie"
      className="h-7 w-7 rounded-md object-cover"
      onError={() => setImageFailed(true)}
    />
  );
}
