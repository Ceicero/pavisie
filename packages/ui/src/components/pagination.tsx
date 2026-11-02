import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './button';

export interface PaginationProps extends React.HTMLAttributes<HTMLDivElement> {
  onPrevious?: () => void;
  onNext?: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
  loading?: boolean;
  label?: string;
}

/** Cursor-style pagination: previous/next only (no page numbers, matching cursor-paginated API responses). */
export const Pagination = React.forwardRef<HTMLDivElement, PaginationProps>(
  ({ className, onPrevious, onNext, hasPrevious, hasNext, loading, label, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-wrap items-center justify-between gap-3', className)} {...props}>
      <p className="min-w-0 text-sm text-muted-foreground">{label}</p>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={onPrevious} disabled={!hasPrevious || loading}>
          <ChevronLeft className="h-4 w-4" />
          Previous
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} disabled={!hasNext || loading}>
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  ),
);
Pagination.displayName = 'Pagination';
