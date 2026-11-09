-- Lets a league admin edit an existing league's name and its current
-- season's settings (picks per week, which sports it syncs from, default
-- pick-lock). Season length is the one field locked to the account's
-- global super admin, since changing it can add or remove weeks that
-- already have games or picks scheduled.

create or replace function update_league_settings(
  p_league_id bigint,
  p_name text,
  p_pick_count_mode text,
  p_pick_count_exact int,
  p_sync_leagues text[],
  p_default_lock_offset_minutes int,
  p_season_weeks int default null
)
returns void
language plpgsql
security definer
as $$
declare
  v_season_id bigint;
  v_current_weeks int;
begin
  if not is_league_admin(p_league_id) then
    raise exception 'Not an admin of this league';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'League name cannot be blank';
  end if;

  if p_sync_leagues is null or cardinality(p_sync_leagues) = 0 then
    raise exception 'Pick at least one league to sync games from';
  end if;

  if p_pick_count_mode = 'exact' and (p_pick_count_exact is null or p_pick_count_exact < 1) then
    raise exception 'Enter how many games each player picks (at least 1)';
  end if;

  update leagues set name = btrim(p_name) where id = p_league_id;

  select id, season_weeks into v_season_id, v_current_weeks
  from seasons
  where league_id = p_league_id and is_current = true;

  if v_season_id is null then
    raise exception 'No current season for this league';
  end if;

  -- Season length only actually changes hands when a caller passes a
  -- different value -- a regular league admin's save (which never sends
  -- this field) always lands here as null-or-unchanged and skips the
  -- super-admin check entirely.
  if p_season_weeks is not null and p_season_weeks is distinct from v_current_weeks then
    if not exists (select 1 from league_users where id = auth.uid() and role = 'admin') then
      raise exception 'Only a super admin can change season length';
    end if;
    if p_season_weeks < 1 then
      raise exception 'Enter a valid season length';
    end if;
    update seasons set season_weeks = p_season_weeks where id = v_season_id;
  end if;

  update seasons set
    pick_count_mode = p_pick_count_mode,
    pick_count_exact = p_pick_count_exact,
    sync_leagues = p_sync_leagues,
    default_lock_offset_minutes = p_default_lock_offset_minutes
  where id = v_season_id;
end;
$$;
