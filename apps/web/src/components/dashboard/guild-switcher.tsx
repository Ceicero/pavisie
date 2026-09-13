'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ChevronsUpDown, PlusCircle } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@pavisie/ui';
import { useGuilds } from '@/lib/dashboard/queries';
import { API_BASE_URL } from '@/lib/dashboard/api';

export interface GuildSwitcherProps {
  currentGuildId: string;
}

function GuildIcon({ name, iconUrl }: { name: string; iconUrl: string | null }) {
  if (iconUrl) {
    return <img src={iconUrl} alt="" className="h-6 w-6 shrink-0 rounded-md object-cover" />;
  }
  return (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold text-muted-foreground">
      {name.slice(0, 2).toUpperCase()}
    </div>
  );
}

/** Dropdown for switching between guilds the user manages, from the sidebar header. */
export function GuildSwitcher({ currentGuildId }: GuildSwitcherProps) {
  const { data: guilds } = useGuilds();
  const router = useRouter();
  const current = guilds?.find((g) => g.id === currentGuildId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2 text-left text-sm shadow-sm hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring">
        <GuildIcon name={current?.name ?? 'Guild'} iconUrl={current?.iconUrl ?? null} />
        <span className="min-w-0 flex-1 truncate font-medium">{current?.name ?? 'Select a server'}</span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="start">
        <DropdownMenuLabel>Your servers</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(guilds ?? [])
          .filter((g) => g.botPresent)
          .map((g) => (
            <DropdownMenuItem key={g.id} onSelect={() => router.push(`/dashboard/${g.id}`)}>
              <GuildIcon name={g.name} iconUrl={g.iconUrl} />
              <span className="flex-1 truncate">{g.name}</span>
              {g.id === currentGuildId ? <Check className="h-4 w-4" /> : null}
            </DropdownMenuItem>
          ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard">
            <ChevronsUpDown className="h-4 w-4" />
            All servers
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={`${API_BASE_URL}/auth/invite`}>
            <PlusCircle className="h-4 w-4" />
            Add to another server
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
