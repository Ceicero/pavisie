'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, PageHeader, Skeleton, useToast } from '@pavisie/ui';
import { useConnectTwitchLink, useTwitchLink, useUnlinkTwitchLink } from '@/lib/dashboard/queries';
import { ApiClientError } from '@/lib/dashboard/api';
import { ConfirmDialog } from '@/components/dashboard/confirm-dialog';

/** Readable messages for the `?error=` codes `routes/auth.ts`'s twitch-link callback branch redirects back
 * with when it bails out instead of completing the link — mirrors `IntegrationsPage`'s
 * `OAUTH_CALLBACK_ERROR_MESSAGES` table. Falls back to a generic message for any code not listed here, so a
 * future new error redirect never renders as a raw, un-mapped code. */
export const TWITCH_LINK_ERROR_MESSAGES: Record<string, string> = {
  'twitch-link-no-verified-connection':
    "Your Discord account doesn't have a verified Twitch connection yet. Go to Discord → User Settings → Connections, add Twitch, and make sure it shows as verified — then try again.",
  'twitch-link-multiple-connections':
    'Your Discord account has more than one Twitch connection. In Discord → User Settings → Connections, remove all but the one you want to link, then try again.',
  'twitch-link-already-claimed':
    'That Twitch account is already linked to a different Discord account. Unlink it there first, then try again here.',
};

/**
 * `/dashboard/account` — "Your account": the one Linked accounts section, Twitch for now
 * (ARCHITECTURE.md §19d). User-level, not guild-scoped — reachable from the account menu in `TopBar`
 * and from the public `/link` shortcut the Twitch bot will one day tell viewers about.
 */
export default function AccountPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const linkQuery = useTwitchLink();
  const connect = useConnectTwitchLink();
  const unlink = useUnlinkTwitchLink();
  const { toast } = useToast();
  const [unlinking, setUnlinking] = React.useState(false);

  // Surfaces the callback's `?linked=twitch` / `?error=...` redirect as a toast, then strips it from the
  // URL so refreshing the page doesn't re-show it — same pattern as `IntegrationsPage`.
  React.useEffect(() => {
    const linked = searchParams.get('linked');
    const error = searchParams.get('error');
    if (linked === 'twitch') {
      toast({ title: 'Twitch account linked', variant: 'success' });
      router.replace('/dashboard/account');
    } else if (error) {
      toast({
        title: 'Could not link Twitch',
        description:
          TWITCH_LINK_ERROR_MESSAGES[error] ??
          'Something went wrong linking your Twitch account. Please try again.',
        variant: 'destructive',
      });
      router.replace('/dashboard/account');
    }
    // Deliberately keyed on `searchParams` alone, so this fires once per incoming redirect, not on every render.
  }, [searchParams]);

  function handleConnect() {
    connect.mutate(undefined, {
      onSuccess: (result) => window.location.assign(result.url),
      onError: (err) =>
        toast({
          title: 'Could not start linking Twitch',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  function confirmUnlink() {
    unlink.mutate(undefined, {
      onSuccess: () => {
        toast({ title: 'Twitch account unlinked', variant: 'success' });
        setUnlinking(false);
      },
      onError: (err) =>
        toast({
          title: 'Could not unlink',
          description: err instanceof ApiClientError ? err.message : 'Please try again.',
          variant: 'destructive',
        }),
    });
  }

  const link = linkQuery.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <PageHeader title="Your account" description="Accounts linked to your Pavisie identity." />

      <Card>
        <CardHeader>
          <CardTitle>Linked accounts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <p className="font-medium">Twitch</p>
                {link?.linked ? <Badge variant="success">Linked</Badge> : null}
              </div>
              {linkQuery.isLoading ? (
                <Skeleton className="h-4 w-40" />
              ) : link?.linked ? (
                <p className="text-sm text-muted-foreground">
                  Linked as <span className="font-medium text-foreground">{link.twitchLogin}</span> on{' '}
                  {new Date(link.linkedAt).toLocaleDateString()}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">Not linked yet.</p>
              )}
            </div>
            {link?.linked ? (
              <Button size="sm" variant="ghost" onClick={() => setUnlinking(true)}>
                Unlink
              </Button>
            ) : (
              <Button size="sm" onClick={handleConnect} disabled={connect.isPending || linkQuery.isLoading}>
                {connect.isPending ? 'Redirecting…' : 'Link Twitch'}
              </Button>
            )}
          </div>

          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">What's read: </span>
              when you click "Link Twitch," Pavisie asks Discord for your verified Twitch connection — nothing
              is read at any other time, and nothing is read at all unless you click the button.
            </p>
            <p>
              <span className="font-medium text-foreground">What's stored: </span>
              your Twitch user id, your Twitch login (for display only), and the date you linked it. Your
              Discord and Twitch access tokens are never stored — they're used once, for the one request that
              reads your connection, and then discarded.
            </p>
            <p>
              <span className="font-medium text-foreground">Why: </span>
              to let you use and earn your Pavisie currency from Twitch chat, once that feature ships.
            </p>
            <p>
              <span className="font-medium text-foreground">Removing it: </span>
              click Unlink at any time — the stored link is deleted immediately.
            </p>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={unlinking}
        onOpenChange={setUnlinking}
        title="Unlink your Twitch account?"
        description="This deletes the stored link right away. You can link it again at any time."
        variant="destructive"
        confirmLabel="Unlink"
        loading={unlink.isPending}
        onConfirm={confirmUnlink}
      />
    </div>
  );
}
