import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';

type Variant = 'primary' | 'secondary' | 'ghost' | 'outline';
type Size = 'md' | 'lg';

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-gold-5 text-ink-0 hover:bg-gold-6 border border-transparent',
  secondary: 'bg-ink-4 text-grey-7 hover:bg-ink-3 border border-ink-6',
  outline: 'bg-transparent text-grey-7 hover:bg-white/[0.06] border border-white/15',
  ghost: 'bg-transparent text-grey-4 hover:text-grey-7 hover:bg-white/[0.04] border border-transparent',
};

const SIZE_CLASSES: Record<Size, string> = {
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
};

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-full font-medium tracking-tight transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-5 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-0 disabled:opacity-40 disabled:pointer-events-none';

interface CommonProps {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

type ButtonProps = CommonProps & ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };
type LinkProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string; external?: boolean };

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button className={clsx(BASE, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className)} {...rest}>
      {icon}
      {children}
    </button>
  );
}

/** Same visual language as `Button`, but renders a link — internal via `next/link`, external via a plain `<a>`. */
export function ButtonLink({
  variant = 'primary',
  size = 'md',
  icon,
  className,
  children,
  href,
  external,
  ...rest
}: LinkProps) {
  const classes = clsx(BASE, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className);
  if (external || href.startsWith('http')) {
    return (
      <a href={href} className={classes} target="_blank" rel="noopener noreferrer" {...rest}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
