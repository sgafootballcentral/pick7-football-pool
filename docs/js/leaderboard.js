import { escapeHtml, avatarInnerHtml, fetchAvatarsByUsername } from "./app.js";
import { getSharedWeek, setSharedWeek } from "./weekState.js";

export function renderLeaderboard(el, { supabase }) {
  // Falls back to Week 1 only if the Picks tab hasn't set a week yet this
  // session (Picks is the default tab, so in practice this almost always
  // already reflects whatever week the player was just looking at there).
  const s = { loading: true, error: "", picksData: [], avatars: {}, selectedWeek: getSharedWeek() || 1 };

  function draw() {
    if (s.loading) {
      el.innerHTML = `<div class="centered"><div class="loading-spinner"></div></div>`;
      return;
    }
    if (s.error) {
      el.innerHTML = `<div class="error-msg">${escapeHtml(s.error)}</div>`;
      return;
    }
    if (!s.picksData.length) {
      el.innerHTML = `<h2>\u{1F3C6} League Standings</h2><div class="card">No player picks have been submitted yet in this league.</div>`;
      return;
    }

    const hasAnyGraded = s.picksData.some((r) => r.wins > 0 || r.losses > 0);
    if (!hasAnyGraded) {
      const roster = [...new Set(s.picksData.map((p) => p.username))];
      el.innerHTML = `
        <h2>\u{1F3C6} League Standings</h2>
        <div class="card">\u{1F3C8} Total standings will update here as soon as games are graded.</div>
        <h3>Active League Roster</h3>
        <div class="card">${roster.map((u) => `
          <div class="player-with-avatar" style="margin-bottom:6px;">
            <span class="avatar-circle-sm">${avatarInnerHtml(s.avatars[u]?.url, s.avatars[u]?.monogram, u)}</span>${escapeHtml(u)}
          </div>
        `).join("")}</div>
      `;
      return;
    }

    // Keyed by the stable user_id, never by the display name -- a rename
    // can never split or orphan someone's record here, because
    // picks_week_tallies (see the "avatars everywhere" migration) groups
    // by user_id in Postgres and joins in whatever the player's CURRENT
    // name is, live, every time this loads.
    const byPlayer = {};
    for (const r of s.picksData) {
      const rec = (byPlayer[r.user_id] ||= { user_id: r.user_id, username: r.username, wins: 0, losses: 0 });
      rec.wins += r.wins;
      rec.losses += r.losses;
    }
    const standings = Object.values(byPlayer).filter((r) => r.wins + r.losses > 0);
    standings.forEach((r) => (r.winPct = r.wins / (r.wins + r.losses)));
    standings.sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses));

    // Rank by wins, ties share a place (1-2-2-4), same as Excel's RANK().
    let lastWins = null, lastPlace = 0;
    standings.forEach((r, i) => {
      if (r.wins !== lastWins) { lastPlace = i + 1; lastWins = r.wins; }
      r.place = lastPlace;
    });
    const medals = { 1: "\u{1F947}", 2: "\u{1F948}", 3: "\u{1F949}" };

    // The view already has (at most) one row per player per week, so this
    // is a direct lookup rather than a re-aggregation.
    const weekByPlayer = {};
    for (const r of s.picksData) {
      if (r.week_number === s.selectedWeek) weekByPlayer[r.user_id] = { wins: r.wins, losses: r.losses };
    }

    const weekOptions = Array.from({ length: 16 }, (_, i) => i + 1);

    el.innerHTML = `
      <h2>\u{1F3C6} League Standings</h2>
      <div class="week-select-row">
        <label class="hint" style="white-space:nowrap;">Show record for week:</label>
        <select id="lb-week-select">
          ${weekOptions.map((w) => `<option value="${w}" ${w === s.selectedWeek ? "selected" : ""}>${w}</option>`).join("")}
        </select>
      </div>
      <div style="overflow-x:auto;">
        <table class="standings">
          <thead><tr><th>Rank</th><th>Player</th><th>Overall</th><th>Week ${s.selectedWeek}</th><th>Win %</th></tr></thead>
          <tbody>
            ${standings.map((r) => {
              const wk = weekByPlayer[r.user_id] || { wins: 0, losses: 0 };
              const rankClass = r.place <= 3 ? `rank-${r.place}` : "";
              return `<tr>
                <td class="${rankClass}">${medals[r.place] || r.place}</td>
                <td><span class="player-with-avatar"><span class="avatar-circle-sm">${avatarInnerHtml(s.avatars[r.username]?.url, s.avatars[r.username]?.monogram, r.username)}</span>${escapeHtml(r.username)}</span></td>
                <td>${r.wins} | ${r.losses}</td>
                <td>${wk.wins} | ${wk.losses}</td>
                <td>${(r.winPct * 100).toFixed(1)}%</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;

    el.querySelector("#lb-week-select").addEventListener("change", (e) => {
      s.selectedWeek = Number(e.target.value);
      setSharedWeek(s.selectedWeek);
      draw();
    });
  }

  (async function init() {
    try {
      // picks_week_tallies is a Postgres view (user_id + week_number -> wins/
      // losses, with the player's current name joined in live) instead of
      // raw picks rows. Two things this fixes at once: (1) the raw picks
      // table recently passed Supabase's default 1000-row API cap, which
      // was silently truncating this unfiltered select and producing
      // wrong, randomly-shifting totals; (2) grouping by user_id instead
      // of by username means a display-name change can never split or
      // orphan anyone's record again, however the rename happens.
      const [{ data, error }, avatars] = await Promise.all([
        supabase.from("picks_week_tallies").select("user_id, username, week_number, wins, losses"),
        fetchAvatarsByUsername(supabase),
      ]);
      if (error) throw error;
      s.picksData = data || [];
      s.avatars = avatars;
      s.loading = false;
      draw();
    } catch (e) {
      s.loading = false;
      s.error = e.message || "Couldn't load standings.";
      draw();
    }
  })();

  draw();
}
