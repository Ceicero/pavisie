'use client';

import * as React from 'react';
import { LogOut, Twitch } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Button, Card, CardContent, PageHeader, Skeleton, useToast } from '@pavisie/ui';
import { useCreatorSession } from '@/lib/creator/session';
import { CreatorChatBot } from './creator-chat-bot';
import { CreatorCurrency } from './creator-currency';

/** Messages for the `?error=` codes the API's OAuth callback redirects back with. */
const ERROR_MESSAGES: Record<string, string> = {
  'twitch-account-mismatch':
    "The Twitch account that approved the bot isn't the one you're signed in with. Switch Twitch accounts in your browser (or sign out of Twitch), then try again.",
};

/**
 * The whole `/creator` page. Signed out: a short explanation and a "Sign in with Twitch" button. Signed in: who
 * you are + sign out, then the chat bot and currency sections. Honest by construction — nothing here shows numbers or activity
 * that does not come from the API.
 */
export function CreatorDashboard() {
  const { status, creator, loginUrl, logout } = useCreatorSession();
  const { toast } = useToast();
  const [notice, setNotice] = React.useState<string | null>(null);

  // The API's OAuth callback lands here with `?connected=twitch-chat` or `?error=<code>`. Read it once, show it,
  // and strip it so a refresh does not repeat it.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const error = params.get('error');
    if (!connected && !error) return;
    if (connected === 'twitch-chat') {
      toast({ title: 'Pavisie is joining your chat', description: 'It can take up to a minute to appear.', variant: 'success' });
    }
    if (error) {
      setNotice(ERROR_MESSAGES[error] ?? 'Something went wrong. Please try again.');
    }
    window.history.replaceState(null, '', window.location.pathname);
  }, [toast]);

  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-4xl space-y-4 px-6 py-8">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (status === 'unauthenticated' || !creator) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Card>
          <CardContent className="space-y-6 p-8">
            <div className="space-y-3">
              <h1 className="text-3xl font-semibold tracking-tight">Use Pavisie on your stream</h1>
              <p className="text-muted-foreground">
                No Discord server needed. Sign in with Twitch to add Pavisie to your chat: custom commands,
                timers, your own viewer currency, and more streaming features as they arrive.
              </p>
            </div>

            {notice ? (
              <Alert variant="warning">
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-2">
              <Button size="lg" asChild>
                <a href={loginUrl}>
                  <Twitch className="h-4 w-4" />
                  Sign in with Twitch
                </a>
              </Button>
              <p className="text-xs text-muted-foreground">
                Signing in only tells Pavisie who you are (your Twitch name and picture). It does not ask for
                access to your account, and your Twitch sign-in token is not kept.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <PageHeader
        title="Creator dashboard"
        description="Manage Pavisie for your Twitch channel."
        actions={
          <div className="flex items-center gap-3">
            {creator.avatarUrl ? (
              <img src={creator.avatarUrl} alt="" className="h-9 w-9 rounded-full" />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                {creator.displayName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 text-right">
              <p className="truncate text-sm font-medium">{creator.displayName}</p>
              <p className="truncate text-xs text-muted-foreground">@{creator.login}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        }
      />

      {notice ? (
        <Alert variant="warning" className="mb-6">
          <AlertTitle>Could not connect</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-10">
        <CreatorChatBot />
        <CreatorCurrency />
      </div>
    </div>
  );
}
