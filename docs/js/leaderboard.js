import { escapeHtml } from "./app.js";
import { getSharedWeek, setSharedWeek } from "./weekState.js";

export function renderLeaderboard(el, { supabase }) {
  // Falls back to Week 1 only if the Picks tab hasn't set a week yet this
  // session (Picks is the default tab, so in practice this almost always
  // already reflects whatever week the player was just looking at there).
  const s = { loading: true, error: "", picksData: [], selectedWeek: getSharedWeek() || 1 };

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

    const graded = s.picksData.filter((p) => p.result === "win" || p.result === "loss");
    if (!graded.length) {
      const roster = [...new Set(s.picksData.map((p) => p.username))];
      el.innerHTML = `
        <h2>\u{1F3C6} League Standings</h2>
        <div class="card">\u{1F3C8} Total standings will update here as soon as games are graded.</div>
        <h3>Active League Roster</h3>
        <div class="card">${roster.map((u) => `<div>${escapeHtml(u)}</div>`).join("")}</div>
      `;
      return;
    }

    const byPlayer = {};
    for (const p of graded) {
      const rec = (byPlayer[p.username] ||= { username: p.username, wins: 0, losses: 0 });
      if (p.result === "win") rec.wins++; else rec.losses++;
    }
    const standings = Object.values(byPlayer);
    standings.forEach((r) => (r.winPct = r.wins / (r.wins + r.losses)));
    standings.sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses));

    // Rank by wins, ties share a place (1-2-2-4), same as Excel's RANK().
    let lastWins = null, lastPlace = 0;
    standings.forEach((r, i) => {
      if (r.wins !== lastWins) { lastPlace = i + 1; lastWins = r.wins; }
      r.place = lastPlace;
    });
    const medals = { 1: "\u{1F947}", 2: "\u{1F948}", 3: "\u{1F949}" };

    const weekPicks = graded.filter((p) => p.week_number === s.selectedWeek);
    const weekByPlayer = {};
    for (const p of weekPicks) {
      const rec = (weekByPlayer[p.username] ||= { wins: 0, losses: 0 });
      if (p.result === "win") rec.wins++; else rec.losses++;
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
              const wk = weekByPlayer[r.username] || { wins: 0, losses: 0 };
              const rankClass = r.place <= 3 ? `rank-${r.place}` : "";
              return `<tr>
                <td class="${rankClass}">${medals[r.place] || r.place}</td>
                <td>${escapeHtml(r.username)}</td>
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
      const { data, error } = await supabase.from("picks").select("username, result, week_number");
      if (error) throw error;
      s.picksData = data || [];
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
