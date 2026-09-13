'use client';

import { AlertTriangle } from 'lucide-react';
import {
  Button,
  CodeBlock,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@pavisie/ui';

export interface SecretRevealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  url?: string;
  secret: string;
}

/** Shows a webhook URL + secret exactly once, right after creation — neither is ever retrievable again. */
export function SecretRevealDialog({ open, onOpenChange, title, url, secret }: SecretRevealDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Save this now — the secret is shown only once and can&apos;t be retrieved again. If you lose it,
            delete this endpoint and create a new one.
          </p>
        </div>

        {url ? (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">URL</p>
            <CodeBlock code={url} />
          </div>
        ) : null}

        <div className="space-y-1.5">
          <p className="text-sm font-medium">Secret</p>
          <CodeBlock code={secret} />
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
