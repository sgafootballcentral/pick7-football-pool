-- game_week_status: one row per (week_number, season_id) instead of one row
-- per game. Several pages only need "which weeks have games" or "which
-- weeks have at least one graded game" for a week-selector dropdown, but
-- were pulling the ENTIRE games table just to get that -- the same
-- unscoped-select shape that already silently truncated the Leaderboard
-- page once `picks` crossed Supabase's 1000-row API cap (see
-- picks_week_tallies above). `games` is still under that cap today, but
-- it's the same bug waiting to happen again as more weeks/seasons get
-- synced in, so this heads it off the same way: aggregate server-side so
-- only one small row per week ever crosses the wire.
create or replace view game_week_status as
select week_number, season_id, bool_or(status = 'final') as any_final
from games
group by week_number, season_id;
