-- Multi-league support: leagues + league_members, seasons.league_id (with
-- "current" becoming per-league instead of global), is_league_admin(),
-- create_league(), join_league_by_code(), and an extended start_new_season().
-- Applied directly against production via the Supabase SQL editor on
-- 2026-11-09. This file documents what was run; it is not wired into a
-- migration runner.

-- Phase A: new tables
create table leagues (
  id bigint generated always as identity primary key,
  name text not null,
  invite_code text not null unique,
  created_by uuid references players(id),
  created_at timestamptz not null default now()
);

create table league_members (
  id bigint generated always as identity primary key,
  league_id bigint not null references leagues(id) on delete cascade,
  user_id uuid not null references players(id) on delete cascade,
  role text not null default 'player' check (role in ('admin', 'player')),
  joined_at timestamptz not null default now(),
  unique (league_id, user_id)
);

alter table leagues enable row level security;
create policy "leagues select all" on leagues for select to authenticated using (true);
grant select on leagues to authenticated;

alter table league_members enable row level security;
create policy "league_members select all" on league_members for select to authenticated using (true);
grant select on league_members to authenticated;

-- Phase B: seasons gets a league_id. "year" was globally unique, which would
-- collide the moment two different leagues both have a season in the same
-- year -- replace it with unique-per-league instead.
alter table seasons add column league_id bigint references leagues(id);
alter table seasons drop constraint if exists seasons_year_key;

-- Phase C: backfill -- the existing pool becomes League #1, every existing
-- player lands on its roster, and whoever is the existing global admin
-- becomes this league's admin too. Nothing re-entered, nothing disrupted.
do $$
declare
  v_league1_id bigint;
begin
  insert into leagues (name, invite_code, created_by)
    select 'Trent''s Pool', upper(substr(md5(random()::text), 1, 8)),
           (select lu.id from league_users lu join players p on p.id = lu.id where lu.role = 'admin' limit 1)
    returning id into v_league1_id;

  update seasons set league_id = v_league1_id;

  insert into league_members (league_id, user_id, role)
    select v_league1_id, p.id,
           case when lu.role = 'admin' then 'admin' else 'player' end
    from players p
    left join league_users lu on lu.id = p.id;
end $$;

alter table seasons alter column league_id set not null;
alter table seasons add constraint seasons_league_year_key unique (league_id, year);

-- Phase D: "current" becomes one-per-league instead of one, globally.
drop index if exists seasons_one_current_idx;
create unique index seasons_one_current_per_league_idx on seasons (league_id) where is_current;

-- Phase E: the season_id ... default current_season_id() safety net made
-- sense when there was only one "current" season to default to. Now that
-- "current" is per-league, a forgotten season_id would silently default to
-- *some* league's current season -- a cross-league data leak, not a safe
-- fallback. Every insert in both apps already passes season_id explicitly
-- (confirmed this session), so a forgotten one should now fail loudly and
-- immediately instead.
alter table games alter column season_id drop default;
alter table picks alter column season_id drop default;
alter table pick_submissions alter column season_id drop default;
alter table week_pick_locks alter column season_id drop default;
alter table pick_lock_exceptions alter column season_id drop default;

-- Phase F: is_league_admin -- the one place "can this user administer this
-- league" is decided server-side. A global league_users.role='admin' row is
-- a super-admin (admin of every league automatically); a league_members row
-- with role='admin' is that one league's own admin.
create or replace function is_league_admin(p_league_id bigint, p_user_id uuid default auth.uid())
returns boolean language sql stable security definer as $$
  select exists (select 1 from league_users where id = p_user_id and role = 'admin')
      or exists (select 1 from league_members where league_id = p_league_id and user_id = p_user_id and role = 'admin');
$$;
grant execute on function is_league_admin(bigint, uuid) to authenticated;

-- Phase G: create_league -- super-admin only (same global gate as today;
-- only Trent can create a league, for now). Generates a unique invite code,
-- inserts the league, and inserts the creator as its first admin.
create or replace function create_league(p_name text)
returns bigint language plpgsql security definer as $$
declare
  v_is_super_admin boolean;
  v_code text;
  v_league_id bigint;
begin
  select (role = 'admin') into v_is_super_admin from league_users where id = auth.uid();
  if not coalesce(v_is_super_admin, false) then
    raise exception 'only a super admin can create a league';
  end if;

  loop
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from leagues where invite_code = v_code);
  end loop;

  insert into leagues (name, invite_code, created_by)
    values (p_name, v_code, auth.uid())
    returning id into v_league_id;

  insert into league_members (league_id, user_id, role)
    values (v_league_id, auth.uid(), 'admin');

  return v_league_id;
end;
$$;
grant execute on function create_league(text) to authenticated;

-- Phase H: join_league_by_code -- any authenticated user. Rejoining is a
-- no-op, not an error.
create or replace function join_league_by_code(p_code text)
returns bigint language plpgsql security definer as $$
declare
  v_league_id bigint;
begin
  select id into v_league_id from leagues where invite_code = upper(p_code);
  if v_league_id is null then
    raise exception 'invalid invite code';
  end if;

  insert into league_members (league_id, user_id, role)
    values (v_league_id, auth.uid(), 'player')
    on conflict (league_id, user_id) do nothing;

  return v_league_id;
end;
$$;
grant execute on function join_league_by_code(text) to authenticated;

-- Phase I: start_new_season gains p_league_id (required, inserted first
-- since it has no default and must precede every defaulted param), scopes
-- the is_current flip + insert to that league, and swaps its admin check to
-- is_league_admin(). Drops the player_seasons carry-forward entirely --
-- roster membership is now league_members, which already persists across a
-- league's seasons, so there's nothing left to carry forward (this also
-- retires the pre-existing gap where a player added after a rollover was
-- never carried into the next season, for free).
drop function if exists start_new_season(integer, text, text, integer, text[], integer, integer);

create or replace function start_new_season(
  p_league_id bigint, p_year integer, p_label text default null,
  p_pick_count_mode text default 'exact', p_pick_count_exact integer default 7,
  p_sync_leagues text[] default '{NFL,CFB}', p_season_weeks integer default 16,
  p_default_lock_offset_minutes integer default null
) returns bigint language plpgsql security definer as $$
declare
  v_old_season_id bigint;
  v_new_season_id bigint;
  v_label text;
begin
  if not is_league_admin(p_league_id) then
    raise exception 'only an admin of this league can start a new season';
  end if;

  select id into v_old_season_id from seasons where league_id = p_league_id and is_current;
  v_label := coalesce(p_label, p_year::text || ' Season');

  if v_old_season_id is not null then
    update seasons set is_current = false where id = v_old_season_id;
  end if;

  insert into seasons (
    league_id, year, label, is_current, pick_count_mode, pick_count_exact,
    sync_leagues, season_weeks, default_lock_offset_minutes
  ) values (
    p_league_id, p_year, v_label, true, p_pick_count_mode, p_pick_count_exact,
    p_sync_leagues, p_season_weeks, p_default_lock_offset_minutes
  )
    returning id into v_new_season_id;

  return v_new_season_id;
end;
$$;
grant execute on function start_new_season(bigint, integer, text, text, integer, text[], integer, integer) to authenticated;
