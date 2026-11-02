-- CareerCrumbs accounts: one row per account holding the whole workspace as JSON.
-- Run this once in the Supabase SQL editor.

create table if not exists public.workspaces (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  rev        bigint not null default 1,          -- bumped on every save; a save must name the rev it started from
  updated_at timestamptz not null default now(),
  constraint workspace_size check (pg_column_size(data) < 2000000)
);

-- Each signed-in person can only see and change their own row.
alter table public.workspaces enable row level security;

drop policy if exists "own workspace: read" on public.workspaces;
drop policy if exists "own workspace: insert" on public.workspaces;
drop policy if exists "own workspace: update" on public.workspaces;
drop policy if exists "own workspace: delete" on public.workspaces;
create policy "own workspace: read"   on public.workspaces for select to authenticated using ((select auth.uid()) = user_id);
create policy "own workspace: insert" on public.workspaces for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own workspace: update" on public.workspaces for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own workspace: delete" on public.workspaces for delete to authenticated using ((select auth.uid()) = user_id);

-- "Delete my account" in the app. Removing the auth user also removes the workspace row (cascade).
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
