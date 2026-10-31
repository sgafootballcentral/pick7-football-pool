-- Season support: seasons table, season_id scoping on games/picks/pick_submissions/
-- week_pick_locks/pick_lock_exceptions, player_seasons junction table, and the
-- start_new_season() admin RPC used to roll the league over to a new year.
-- Applied directly against production via the Supabase SQL editor on 2026-10-31.
-- This file documents what was run; it is not wired into a migration runner.

-- Phase A: seasons table
create table if not exists seasons (
  id bigint generated always as identity primary key,
  year integer not null unique,
  label text not null,
  is_current boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists seasons_one_current_idx on seasons (is_current) where is_current;
insert into seasons (year, label, is_current)
  select 2026, '2026 Season', true where not exists (select 1 from seasons);
alter table seasons enable row level security;
create policy "seasons select all" on seasons for select to authenticated using (true);
grant select on seasons to authenticated;

-- Phase B: season_id columns on existing tables, backfilled to the current season
alter table games add column if not exists season_id bigint references seasons(id);
alter table picks add column if not exists season_id bigint references seasons(id);
alter table pick_submissions add column if not exists season_id bigint references seasons(id);
alter table week_pick_locks add column if not exists season_id bigint references seasons(id);
alter table pick_lock_exceptions add column if not exists season_id bigint references seasons(id);

update games set season_id = (select id from seasons where is_current) where season_id is null;
update picks set season_id = (select id from seasons where is_current) where season_id is null;
update pick_submissions set season_id = (select id from seasons where is_current) where season_id is null;
update week_pick_locks set season_id = (select id from seasons where is_current) where season_id is null;
update pick_lock_exceptions set season_id = (select id from seasons where is_current) where season_id is null;

alter table games alter column season_id set not null;
alter table picks alter column season_id set not null;
alter table pick_submissions alter column season_id set not null;
alter table week_pick_locks alter column season_id set not null;
alter table pick_lock_exceptions alter column season_id set not null;

-- Phase C: week_pick_locks previously had PK (week_number) alone, which would
-- collide across seasons. Move to a composite key.
alter table week_pick_locks drop constraint week_pick_locks_pkey;
alter table week_pick_locks add primary key (season_id, week_number);

-- Phase D: player_seasons junction table (who's opted in to which season)
create table if not exists player_seasons (
  id bigint generated always as identity primary key,
  season_id bigint not null references seasons(id) on delete cascade,
  user_id uuid not null references players(id) on delete cascade,
  active boolean not null default true,
  joined_at timestamptz not null default now(),
  unique (season_id, user_id)
);
insert into player_seasons (season_id, user_id, active)
  select (select id from seasons where is_current), id, true from players
  on conflict (season_id, user_id) do nothing;
alter table player_seasons enable row level security;
create policy "player_seasons select all" on player_seasons for select to authenticated using (true);
create policy "player_seasons insert own" on player_seasons for insert to authenticated with check (user_id = auth.uid());
create policy "player_seasons update own" on player_seasons for update to authenticated using (user_id = auth.uid());
create policy "player_seasons admin all" on player_seasons for all to authenticated
  using (exists (select 1 from league_users lu where lu.id = auth.uid() and lu.role = 'admin'));
grant select, insert, update on player_seasons to authenticated;

-- Phase E: start_new_season RPC -- admin-only, rolls the league over to a new year,
-- carrying forward anyone who was active in the outgoing season.
create or replace function start_new_season(p_year integer, p_label text default null)
returns bigint language plpgsql security definer as $$
declare
  v_is_admin boolean;
  v_old_season_id bigint;
  v_new_season_id bigint;
  v_label text;
begin
  select (role = 'admin') into v_is_admin from league_users where id = auth.uid();
  if not coalesce(v_is_admin, false) then
    raise exception 'only admins can start a new season';
  end if;

  select id into v_old_season_id from seasons where is_current;
  v_label := coalesce(p_label, p_year::text || ' Season');

  update seasons set is_current = false where id = v_old_season_id;
  insert into seasons (year, label, is_current) values (p_year, v_label, true)
    returning id into v_new_season_id;

  insert into player_seasons (season_id, user_id, active)
    select v_new_season_id, user_id, true from player_seasons
    where season_id = v_old_season_id and active = true
    on conflict (season_id, user_id) do nothing;

  return v_new_season_id;
end;
$$;
grant execute on function start_new_season(integer, text) to authenticated;

-- Safety net: until app code is updated to pass season_id explicitly (see
-- follow-up tasks for picks.js / Admin.py), default new rows to the current
-- season so existing inserts that don't know about season_id don't break.
create or replace function current_season_id() returns bigint language sql stable as $$
  select id from seasons where is_current limit 1
$$;
alter table games alter column season_id set default current_season_id();
alter table picks alter column season_id set default current_season_id();
alter table pick_submissions alter column season_id set default current_season_id();
alter table week_pick_locks alter column season_id set default current_season_id();
alter table pick_lock_exceptions alter column season_id set default current_season_id();
