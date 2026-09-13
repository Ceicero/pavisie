'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, Gavel, LifeBuoy, Puzzle, ScrollText, ShieldAlert, Users } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Skeleton,
  StatCard,
} from '@pavisie/ui';
import { useGuild } from '@/lib/dashboard/queries';
import { ErrorState } from '@/components/dashboard/error-state';

const QUICK_LINKS = [
  { href: 'plugins', label: 'Manage plugins', icon: Puzzle },
  { href: 'moderation', label: 'Moderation cases', icon: Gavel },
  { href: 'automod', label: 'Automod rules', icon: ShieldAlert },
  { href: 'tickets', label: 'Ticket queue', icon: LifeBuoy },
];

export default function GuildOverviewPage() {
  const { guildId } = useParams<{ guildId: string }>();
  const { data, isLoading, error, refetch } = useGuild(guildId);

  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-56" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const stats = data.stats ?? {};
  const plugins = data.plugins ?? [];
  const degraded = plugins.filter((p) => p.enabled && p.health && p.health.status !== 'ok');

  return (
    <div className="space-y-6">
      <PageHeader title={data.guild.name} description="Overview of this server's Pavisie setup." />

      {data.setupIncomplete ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>Setup incomplete</AlertTitle>
          <AlertDescription>
            {data.setupIssues && data.setupIssues.length > 0 ? (
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {data.setupIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : (
              'Run /setup wizard in Discord, or finish configuring plugins here.'
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Members" value={stats.memberCount ?? '—'} icon={<Users />} />
        <StatCard
          label="Plugins enabled"
          value={stats.pluginsEnabled ?? plugins.filter((p) => p.enabled).length}
          icon={<Puzzle />}
        />
        <StatCard label="Open tickets" value={stats.openTickets ?? '—'} icon={<LifeBuoy />} />
        <StatCard label="Cases (7d)" value={stats.moderationCasesLast7d ?? '—'} icon={<Gavel />} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Plugin health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {plugins.length === 0 ? (
              <p className="text-sm text-muted-foreground">No plugin data yet.</p>
            ) : (
              plugins
                .filter((p) => p.enabled)
                .map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0"
                  >
                    <span>{p.name}</span>
                    <Badge
                      variant={
                        !p.health || p.health.status === 'ok'
                          ? 'success'
                          : p.health.status === 'unavailable'
                            ? 'destructive'
                            : 'warning'
                      }
                    >
                      {p.health?.status ?? 'ok'}
                    </Badge>
                  </div>
                ))
            )}
            {degraded.length > 0 ? (
              <p className="pt-1 text-xs text-muted-foreground">
                <ScrollText className="mr-1 inline h-3 w-3" />
                Check the Plugins page for details on degraded plugins.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick links</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            {QUICK_LINKS.map((link) => (
              <Link
                key={link.href}
                href={`/dashboard/${guildId}/${link.href}`}
                className="flex items-center gap-2 rounded-md border border-border p-3 text-sm font-medium transition-colors hover:bg-accent"
              >
                <link.icon className="h-4 w-4 text-muted-foreground" />
                {link.label}
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
