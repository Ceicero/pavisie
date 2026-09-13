import type { HTMLAttributes, ReactNode } from 'react';
import { clsx } from 'clsx';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: 'default' | 'outline' | 'solid';
  className?: string;
}

/** Grey badge/chip. Not restyled with the gold brand accent here — that's a separate design pass
 * (SPEC.md §O has the current gold-and-black brand rules). */
export function Badge({ children, tone = 'default', className, ...rest }: BadgeProps) {
  const toneClasses =
    tone === 'solid'
      ? 'bg-grey-7 text-ink-0'
      : tone === 'outline'
        ? 'border border-white/15 text-grey-4'
        : 'bg-white/[0.06] text-grey-4';

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
        toneClasses,
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
