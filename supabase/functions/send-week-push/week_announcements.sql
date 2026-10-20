create table if not exists public.week_announcements (
  id bigint generated always as identity primary key,
  week_number integer not null unique,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.week_announcements enable row level security;

drop policy if exists "week_announcements readable by all" on public.week_announcements;
create policy "week_announcements readable by all"
on public.week_announcements for select
using (true);

drop policy if exists "admins can insert week announcements" on public.week_announcements;
create policy "admins can insert week announcements"
on public.week_announcements for insert
with check (
  exists (
    select 1 from league_users
    where league_users.id = auth.uid()
    and league_users.role = 'admin'
  )
);
