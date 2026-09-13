'use client';

// Manifest-aware brand logo (ARCHITECTURE.md §22): reads the sync-brand-generated `src/data/brand.json` for the
// logo path known at build time, and additionally hides the `<img>` on a runtime 404 (belt-and-braces — e.g. a
// stale build artifact) via `onError`, falling back to a plain text wordmark either way.
import { useState } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import brand from '../data/brand.json';

interface LogoProps {
  className?: string;
  imageSize?: number;
  withWordmark?: boolean;
  href?: string;
}

export function Logo({ className, imageSize = 28, withWordmark = true, href = '/' }: LogoProps) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(brand.logo) && !failed;

  return (
    <Link href={href} className={clsx('inline-flex items-center gap-2.5 select-none', className)}>
      {showImage ? (
        // Fixed small brand mark; next/image adds no value here and this repo keeps images.unoptimized anyway.
        <img
          src={brand.logo ?? undefined}
          alt="Pavisie"
          width={imageSize}
          height={imageSize}
          className="rounded-md object-cover"
          style={{ width: imageSize, height: imageSize }}
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex items-center justify-center rounded-md border border-grey-1 font-bold text-grey-7"
          style={{ width: imageSize, height: imageSize, fontSize: imageSize * 0.5 }}
        >
          E
        </span>
      )}
      {withWordmark && <span className="text-base font-semibold tracking-tight text-grey-7">Pavisie</span>}
    </Link>
  );
}
