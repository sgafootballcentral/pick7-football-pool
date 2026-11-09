-- Lets the account's global super admin permanently delete a league and
-- everything in it. Two client-side confirmation layers (an explanation of
-- exactly what's about to be destroyed, then a one-time code that must be
-- typed back exactly) sit in front of this in both apps -- this RPC itself
-- only re-checks WHO is calling, not how they got here, so it stays safe
-- even if a client's own UI gating were ever skipped or bypassed.
--
-- Deletion order matters: league_members, chat_reads, and player_seasons
-- all have "on delete cascade" FKs and clean themselves up automatically.
-- Everything else referencing leagues/seasons (chat_messages, seasons
-- itself, and everything hanging off seasons -- games, picks,
-- pick_submissions, week_pick_locks, pick_lock_exceptions) is NO ACTION,
-- so it has to be deleted explicitly, in dependency order, before the
-- league row itself goes. chat_reactions cascades off chat_messages.

create or replace function delete_league(p_league_id bigint)
returns void
language plpgsql
security definer
as $$
declare
  v_season_ids bigint[];
begin
  if not exists (select 1 from league_users where id = auth.uid() and role = 'admin') then
    raise exception 'Only a super admin can delete a league';
  end if;

  if not exists (select 1 from leagues where id = p_league_id) then
    raise exception 'League not found';
  end if;

  select array_agg(id) into v_season_ids from seasons where league_id = p_league_id;

  -- A player's "last recap" pointer must survive even though the season
  -- it points at won't -- the player themselves isn't being deleted.
  update players set last_recap_season_id = null
  where last_recap_season_id = any(v_season_ids);

  delete from picks where season_id = any(v_season_ids);
  delete from pick_submissions where season_id = any(v_season_ids);
  delete from week_pick_locks where season_id = any(v_season_ids);
  delete from pick_lock_exceptions where season_id = any(v_season_ids);
  delete from games where season_id = any(v_season_ids);
  delete from seasons where league_id = p_league_id;

  delete from chat_messages where league_id = p_league_id;

  delete from leagues where id = p_league_id;
end;
$$;
