import type { HTMLAttributes, ReactNode } from 'react';
import { clsx } from 'clsx';

interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  id?: string;
  eyebrow?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  className?: string;
  as?: 'section' | 'div';
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
}

/** Consistent section shell: max-width container, generous vertical rhythm, optional eyebrow/title/subtitle. */
export function Section({
  id,
  eyebrow,
  title,
  subtitle,
  children,
  className,
  as = 'section',
  headingLevel = 2,
  ...rest
}: SectionProps) {
  const Tag = as;
  const HeadingTag = `h${headingLevel}` as const;

  return (
    <Tag id={id} className={clsx('mx-auto max-w-6xl px-6 py-16 sm:py-24', className)} {...rest}>
      {(eyebrow || title || subtitle) && (
        <div className="mb-12 max-w-2xl">
          {eyebrow && (
            <p className="text-xs font-semibold uppercase tracking-widest text-grey-3">{eyebrow}</p>
          )}
          {title && (
            <HeadingTag className="mt-2 text-3xl font-semibold tracking-tight text-grey-7 sm:text-4xl">
              {title}
            </HeadingTag>
          )}
          {subtitle && <p className="mt-4 text-base leading-relaxed text-grey-3">{subtitle}</p>}
        </div>
      )}
      {children}
    </Tag>
  );
}
