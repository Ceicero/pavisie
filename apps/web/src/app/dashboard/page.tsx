'use client';

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Button, Card, CardContent, EmptyState, PageHeader, Skeleton } from '@pavisie/ui';
import { useGuilds } from '@/lib/dashboard/queries';
import { ErrorState } from '@/components/dashboard/error-state';
import { API_BASE_URL } from '@/lib/dashboard/api';

function GuildIcon({ name, iconUrl }: { name: string; iconUrl: string | null }) {
  if (iconUrl) {
    return <img src={iconUrl} alt="" className="h-12 w-12 rounded-xl object-cover" />;
  }
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-sm font-semibold text-muted-foreground">
      {name.slice(0, 2).toUpperCase()}
    </div>
  );
}

/** Guild selector: every server the user can manage, with an "Add to server" path for guilds without the bot. */
export default function GuildSelectorPage() {
  const { data: guilds, isLoading, error, refetch } = useGuilds();

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <PageHeader title="Your servers" description="Pick a server to configure Pavisie for it." />

      {error ? <ErrorState error={error} onRetry={() => refetch()} /> : null}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : null}

      {!isLoading && !error && (!guilds || guilds.length === 0) ? (
        <EmptyState
          title="No servers found"
          description="You need Manage Server permission on a Discord server for it to show up here."
        />
      ) : null}

      {guilds && guilds.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {guilds.map((guild) => (
            <Card key={guild.id}>
              <CardContent className="flex flex-col gap-3 p-5">
                <div className="flex items-center gap-3">
                  <GuildIcon name={guild.name} iconUrl={guild.iconUrl} />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{guild.name}</p>
                    <p className="text-xs text-muted-foreground">{guild.owner ? 'Owner' : 'Manager'}</p>
                  </div>
                </div>
                {guild.botPresent ? (
                  <Button asChild>
                    <Link href={`/dashboard/${guild.id}`}>Manage</Link>
                  </Button>
                ) : (
                  <Button variant="outline" asChild>
                    <a href={`${API_BASE_URL}/auth/invite?guild_id=${guild.id}`}>
                      <Plus className="h-4 w-4" />
                      Add Pavisie
                    </a>
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
