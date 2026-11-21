-- Lets the Picks page's team/conference search (added this same round)
-- use ESPN's own conference data for a game's two teams, instead of
-- guessing a conference from the team's display name. The ESPN sync in
-- pages/1_Admin.py now reads each team's conferenceId straight off the
-- scoreboard response it already pulls spreads and kickoff times from,
-- resolves it to a conference name, and stores it here going forward.
--
-- Nullable and left unbackfilled on purpose: games synced before this
-- column existed, manually-added games, and all NFL games (ESPN's
-- scoreboard doesn't tag NFL teams with a conferenceId) just have no
-- value here -- the search falls back to a small static name-based guess
-- for those instead of refusing to match.

alter table games
  add column if not exists favorite_conference text,
  add column if not exists underdog_conference text;
