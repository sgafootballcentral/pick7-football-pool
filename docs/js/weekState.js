// Shared "which week is currently selected" between the Picks and
// Leaderboard tabs, so switching tabs keeps showing the same week instead of
// always resetting the Leaderboard back to Week 1. Whoever last picked a
// week (Picks tab on load/switch, or the Leaderboard's own selector) wins --
// same idea as the Streamlit site's shared "global_week" session value.
let sharedWeek = null;

export function getSharedWeek() {
  return sharedWeek;
}

export function setSharedWeek(week) {
  sharedWeek = week;
}
