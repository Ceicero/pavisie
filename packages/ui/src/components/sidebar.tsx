'use client';

import * as React from 'react';
import { Slot, Slottable } from '@radix-ui/react-slot';
import { cn } from '../lib/cn';
import { Sheet, SheetContent } from './sheet';

export interface SidebarProps {
  children: React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  className?: string;
}

/**
 * App shell sidebar: a fixed column on desktop, a slide-in Sheet on mobile/tablet.
 * Callers own the nav content (icons, links) and pass it as `children` so this component
 * has no dependency on routing.
 */
export function Sidebar({
  children,
  header,
  footer,
  mobileOpen,
  onMobileOpenChange,
  className,
}: SidebarProps) {
  return (
    <>
      <aside
        className={cn(
          'hidden shrink-0 flex-col border-r border-border bg-card lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-64',
          className,
        )}
      >
        {header ? <div className="border-b border-border p-4">{header}</div> : null}
        <nav className="flex-1 overflow-y-auto p-3">{children}</nav>
        {footer ? <div className="border-t border-border p-3">{footer}</div> : null}
      </aside>
      <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
        <SheetContent side="left" className="w-72 p-0">
          {header ? <div className="border-b border-border p-4">{header}</div> : null}
          <nav className="flex-1 overflow-y-auto p-3">{children}</nav>
          {footer ? <div className="border-t border-border p-3">{footer}</div> : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

export interface SidebarSectionProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
}

export function SidebarSection({ title, className, children, ...props }: SidebarSectionProps) {
  return (
    <div className={cn('mb-4', className)} {...props}>
      {title ? (
        <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
      ) : null}
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export interface SidebarNavItemProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  icon?: React.ReactNode;
  active?: boolean;
  asChild?: boolean;
  suffix?: React.ReactNode;
}

/**
 * A single nav row. Pass `asChild` with a routing `<Link>` as the sole child to integrate
 * with Next.js routing; wrap the label in `<span className="flex-1 truncate">` inside the
 * link to keep the layout (Radix `Slot` renders the link itself, so this component can only
 * add the icon/suffix as siblings of the link's own content via `Slottable`, not wrap it).
 */
export const SidebarNavItem = React.forwardRef<HTMLAnchorElement, SidebarNavItemProps>(
  ({ icon, active, asChild, suffix, className, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'a';
    return (
      <Comp
        ref={ref}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0',
          active
            ? 'border-l-2 border-gold-5 bg-gold-5/10 text-gold-5'
            : 'border-l-2 border-transparent text-muted-foreground hover:border-gold-5/40 hover:text-foreground',
          className,
        )}
        {...props}
      >
        {icon}
        {asChild ? <Slottable>{children}</Slottable> : <span className="flex-1 truncate">{children}</span>}
        {suffix}
      </Comp>
    );
  },
);
SidebarNavItem.displayName = 'SidebarNavItem';
