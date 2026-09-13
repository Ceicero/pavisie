import { AlertTriangle, MessageCircle } from 'lucide-react';
import { Button, EmptyState } from '@pavisie/ui';
import { ApiClientError } from '@/lib/dashboard/api';
import { supportServerUrl } from '@/lib/site';

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}

/** Standard error display for a failed query, with a human message and an optional retry button. */
export function ErrorState({ error, onRetry, title = 'Something went wrong' }: ErrorStateProps) {
  const description =
    error instanceof ApiClientError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'An unexpected error occurred.';
  const support = supportServerUrl();
  const hasAction = Boolean(onRetry) || Boolean(support);

  return (
    <EmptyState
      icon={<AlertTriangle />}
      title={title}
      description={description}
      action={
        hasAction ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onRetry ? (
              <Button variant="outline" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
            {support ? (
              <Button variant="ghost" asChild>
                <a href={support} target="_blank" rel="noopener noreferrer">
                  <MessageCircle className="h-4 w-4" />
                  Get help on Discord
                </a>
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    />
  );
}
