-- Marker table for the "📢 Notify Players -- Week N Results Are In" button
-- on the Leaderboard page (admin-only, next to Current Standings). One row
-- per send -- unlike week_announcements, week_number is deliberately NOT
-- unique here: this is an explicit admin action, not something that fires
-- automatically on a re-sync, so there's no "accidental duplicate" case to
-- guard against, and an admin might legitimately want to resend (e.g. after
-- fixing a grading mistake).
create table if not exists public.week_graded_announcements (
  id bigint generated always as identity primary key,
  week_number integer not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.week_graded_announcements enable row level security;

drop policy if exists "week_graded_announcements readable by all" on public.week_graded_announcements;
create policy "week_graded_announcements readable by all"
on public.week_graded_announcements for select
using (true);

drop policy if exists "admins can insert week graded announcements" on public.week_graded_announcements;
create policy "admins can insert week graded announcements"
on public.week_graded_announcements for insert
with check (
  exists (
    select 1 from league_users
    where league_users.id = auth.uid()
    and league_users.role = 'admin'
  )
);
