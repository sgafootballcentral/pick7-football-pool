-- Season setup options: pick-count mode, sync leagues, season length,
-- default pick-lock offset. Lets an admin configure how a new season should
-- behave (e.g. the CFB Playoffs: pick every game, CFB only, a short season)
-- instead of the hardcoded exactly-7/NFL+CFB/16-weeks/manual-lock-only
-- behavior the app has had until now. All five new columns default to
-- exactly that existing behavior, so the live current season needs no
-- separate backfill -- ADD COLUMN ... DEFAULT already back-fills it.
-- Applied directly against production via the Supabase SQL editor on 2026-11-09.
-- This file documents what was run; it is not wired into a migration runner.

alter table seasons add column pick_count_mode text not null default 'exact'
  check (pick_count_mode in ('exact', 'all'));
alter table seasons add column pick_count_exact integer not null default 7
  check (pick_count_exact > 0);
alter table seasons add column sync_leagues text[] not null default '{NFL,CFB}'
  check (array_length(sync_leagues, 1) > 0);
alter table seasons add column season_weeks integer not null default 16
  check (season_weeks > 0);
alter table seasons add column default_lock_offset_minutes integer; -- null = off, admin sets locks by hand like today

-- Adding parameters changes the function's signature, so create or replace
-- would create a second overloaded function instead of replacing this one --
-- drop the old 2-arg version first.
drop function if exists start_new_season(integer, text);

create or replace function start_new_season(
  p_year integer, p_label text default null,
  p_pick_count_mode text default 'exact', p_pick_count_exact integer default 7,
  p_sync_leagues text[] default '{NFL,CFB}', p_season_weeks integer default 16,
  p_default_lock_offset_minutes integer default null
) returns bigint language plpgsql security definer as $$
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
  insert into seasons (
    year, label, is_current, pick_count_mode, pick_count_exact,
    sync_leagues, season_weeks, default_lock_offset_minutes
  ) values (
    p_year, v_label, true, p_pick_count_mode, p_pick_count_exact,
    p_sync_leagues, p_season_weeks, p_default_lock_offset_minutes
  )
    returning id into v_new_season_id;

  insert into player_seasons (season_id, user_id, active)
    select v_new_season_id, user_id, true from player_seasons
    where season_id = v_old_season_id and active = true
    on conflict (season_id, user_id) do nothing;

  return v_new_season_id;
end;
$$;
grant execute on function start_new_season(integer, text, text, integer, text[], integer, integer) to authenticated;
