import { escapeHtml } from "./app.js";
import { getSharedWeek, setSharedWeek } from "./weekState.js";

// Same chronological numbering scheme picks.js uses (favorite=odd,
// underdog=even) -- not used for the grid/head-to-head display itself
// (those are keyed by game, not by side), but kept available in case a
// future view wants it.
function orderGamesByKickoff(games) {
  return [...games].sort((a, b) => (a.kickoff_time || "").localeCompare(b.kickoff_time || ""));
}

function formatLockAt(iso) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

export function renderCompare(el, { supabase, username }) {
  const s = {
    loading: true,
    error: "",
    weeks: [],
    week: getSharedWeek() || 1,
    games: [],
    picksByUsername: {}, // username -> [picks rows] for s.week
    weekLock: null, // week_pick_locks row for s.week, or null
    mode: "grid", // "grid" | "h2h"
    h2hA: "",
    h2hB: "",
  };

  // Same idea as the weekly pick lock everywhere else in the app: unlocked
  // once the admin's lock time passes, OR once every game in the week has
  // already kicked off (at that point there's nothing left to "scout"
  // anyway, even if the admin never set an explicit lock time).
  function isCompareUnlocked() {
    const now = new Date();
    if (s.weekLock?.lock_at && now >= new Date(s.weekLock.lock_at)) return true;
    if (s.games.length && s.games.every((g) => now >= new Date(g.kickoff_time))) return true;
    return false;
  }

  function weekSelectHtml() {
    return `
      <div class="week-select-row">
        <label class="hint" style="white-space:nowrap;">Week:</label>
        <select id="cmp-week-select">
          ${s.weeks.map((w) => `<option value="${w}" ${w === s.week ? "selected" : ""}>${w}</option>`).join("")}
        </select>
      </div>
    `;
  }

  function resultBadge(result) {
    if (result === "win") return ` <span class="pick-result win">✅</span>`;
    if (result === "loss") return ` <span class="pick-result loss">❌</span>`;
    return "";
  }

  function drawGrid(orderedGames) {
    const players = Object.keys(s.picksByUsername).sort((a, b) => a.localeCompare(b));
    if (!players.length) {
      return `<div class="card">No picks have been submitted yet for Week ${s.week}.</div>`;
    }

    const rows = players.map((p) => {
      const picksByGame = {};
      for (const pk of s.picksByUsername[p]) picksByGame[pk.game_id] = pk;
      let wins = 0, losses = 0;
      const cells = orderedGames.map((g) => {
        const pk = picksByGame[g.game_id];
        if (!pk || !pk.selected_team) return `<td class="cmp-cell cmp-empty">—</td>`;
        if (pk.result === "win") wins++;
        else if (pk.result === "loss") losses++;
        const cls = pk.result === "win" ? "cmp-win" : pk.result === "loss" ? "cmp-loss" : "";
        return `<td class="cmp-cell ${cls}">${escapeHtml(pk.selected_team)}${resultBadge(pk.result)}</td>`;
      });
      const isMe = p === username;
      return `<tr class="${isMe ? "cmp-me" : ""}">
        <td class="cmp-player">${escapeHtml(p)}${isMe ? " <span class=\"hint\">(you)</span>" : ""}</td>
        ${cells.join("")}
        <td class="cmp-record">${wins}-${losses}</td>
      </tr>`;
    });

    return `
      <div style="overflow-x:auto;">
        <table class="standings cmp-grid">
          <thead><tr>
            <th>Player</th>
            ${orderedGames.map((g, i) => `<th title="${escapeHtml(g.display_text || "")} (${escapeHtml(g.spread_value || "")})">G${i + 1}</th>`).join("")}
            <th>W-L</th>
          </tr></thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
      <div class="hint" style="margin-top:8px;">Hover (or tap) a column header to see that game's matchup and spread. ✅/❌ shows once a pick is graded.</div>
    `;
  }

  function drawH2H(orderedGames) {
    const players = Object.keys(s.picksByUsername).sort((a, b) => a.localeCompare(b));
    if (players.length < 2) {
      return `<div class="card">Need at least two players' picks on file for Week ${s.week} to compare head-to-head.</div>`;
    }
    if (!s.h2hA || !players.includes(s.h2hA)) s.h2hA = players.includes(username) ? username : players[0];
    if (!s.h2hB || !players.includes(s.h2hB) || s.h2hB === s.h2hA) {
      s.h2hB = players.find((p) => p !== s.h2hA) || "";
    }

    const pickerRow = `
      <div class="field" style="display:flex; gap:10px;">
        <div style="flex:1;">
          <label>Player A</label>
          <select id="cmp-h2h-a">
            ${players.map((p) => `<option value="${escapeHtml(p)}" ${p === s.h2hA ? "selected" : ""}>${escapeHtml(p)}</option>`).join("")}
          </select>
        </div>
        <div style="flex:1;">
          <label>Player B</label>
          <select id="cmp-h2h-b">
            ${players.filter((p) => p !== s.h2hA).map((p) => `<option value="${escapeHtml(p)}" ${p === s.h2hB ? "selected" : ""}>${escapeHtml(p)}</option>`).join("")}
          </select>
        </div>
      </div>
    `;

    const aPicks = Object.fromEntries((s.picksByUsername[s.h2hA] || []).map((p) => [p.game_id, p]));
    const bPicks = Object.fromEntries((s.picksByUsername[s.h2hB] || []).map((p) => [p.game_id, p]));

    let agree = 0, comparable = 0, aWins = 0, aLosses = 0, bWins = 0, bLosses = 0;
    const gameRows = orderedGames.map((g) => {
      const a = aPicks[g.game_id];
      const b = bPicks[g.game_id];
      if (a?.result === "win") aWins++; else if (a?.result === "loss") aLosses++;
      if (b?.result === "win") bWins++; else if (b?.result === "loss") bLosses++;
      const same = a && b && a.selected_team && a.selected_team === b.selected_team;
      if (a?.selected_team && b?.selected_team) {
        comparable++;
        if (same) agree++;
      }
      return `
        <div class="card h2h-row ${same ? "h2h-agree" : ""}">
          <div class="hint">${escapeHtml(g.display_text || "")} <span class="cmp-spread">(${escapeHtml(g.spread_value || "")})</span></div>
          <div style="display:flex; justify-content:space-between; margin-top:6px; gap:10px;">
            <div style="flex:1;">${a?.selected_team ? `${escapeHtml(a.selected_team)}${resultBadge(a.result)}` : `<span class="hint">No pick</span>`}</div>
            <div style="flex:1; text-align:right;">${b?.selected_team ? `${escapeHtml(b.selected_team)}${resultBadge(b.result)}` : `<span class="hint">No pick</span>`}</div>
          </div>
          ${same ? `<div class="hint" style="margin-top:4px;">\u{1F91D} Same pick</div>` : ""}
        </div>
      `;
    }).join("");

    return `
      ${pickerRow}
      <div class="card" style="text-align:center;">
        <b>${escapeHtml(s.h2hA)}</b> ${aWins}-${aLosses} &nbsp;vs&nbsp; <b>${escapeHtml(s.h2hB)}</b> ${bWins}-${bLosses}
        <div class="hint" style="margin-top:4px;">Agree on ${agree} of ${comparable} comparable pick(s) this week.</div>
      </div>
      <div style="display:flex; justify-content:space-between; padding:0 4px;">
        <b>${escapeHtml(s.h2hA)}</b><b>${escapeHtml(s.h2hB)}</b>
      </div>
      ${gameRows}
    `;
  }

  function draw() {
    if (s.loading) {
      el.innerHTML = `<div class="centered"><div class="loading-spinner"></div></div>`;
      return;
    }
    if (s.error) {
      el.innerHTML = `<div class="error-msg">${escapeHtml(s.error)}</div>`;
      return;
    }
    if (!s.weeks.length) {
      el.innerHTML = `<h2>\u{1F86A} Compare Picks</h2><div class="card">No games have been loaded yet. Check back once the games are set up.</div>`;
      return;
    }

    const unlocked = isCompareUnlocked();

    if (!unlocked) {
      const lockNote = s.weekLock?.lock_at
        ? `Picks for Week ${s.week} unlock for comparison once they lock, at ${formatLockAt(s.weekLock.lock_at)} ET.`
        : `Picks for Week ${s.week} unlock for comparison once its games kick off, or once an admin sets a weekly lock time -- whichever comes first.`;
      el.innerHTML = `
        <h2>\u{1F86A} Compare Picks</h2>
        ${weekSelectHtml()}
        <div class="card">\u{1F512} ${escapeHtml(lockNote)}</div>
      `;
      el.querySelector("#cmp-week-select").addEventListener("change", (e) => {
        s.week = Number(e.target.value);
        setSharedWeek(s.week);
        loadWeek();
      });
      return;
    }

    const orderedGames = orderGamesByKickoff(s.games);

    // The Everyone grid only makes sense for games at least one player
    // actually picked -- a game nobody picked yet (or ever, if it's not part
    // of anyone's 7) would just be an all-"\u2014" column. Head-to-head is left
    // showing the full week either way, since "neither of us picked this
    // one" is still meaningful there.
    const pickedGameIds = new Set();
    Object.values(s.picksByUsername).forEach((picks) => {
      picks.forEach((p) => { if (p.selected_team) pickedGameIds.add(p.game_id); });
    });
    const gridGames = orderedGames.filter((g) => pickedGameIds.has(g.game_id));

    el.innerHTML = `
      <h2>\u{1F86A} Compare Picks</h2>
      ${weekSelectHtml()}
      <div class="btn-row" style="margin-bottom:12px;">
        <button class="btn ${s.mode === "grid" ? "btn-primary" : "btn-secondary"}" id="cmp-mode-grid">\u{1F4CA} Everyone</button>
        <button class="btn ${s.mode === "h2h" ? "btn-primary" : "btn-secondary"}" id="cmp-mode-h2h">\u{1F19A} Head-to-Head</button>
      </div>
      ${s.mode === "grid" ? drawGrid(gridGames) : drawH2H(orderedGames)}
    `;

    el.querySelector("#cmp-week-select").addEventListener("change", (e) => {
      s.week = Number(e.target.value);
      setSharedWeek(s.week);
      loadWeek();
    });
    el.querySelector("#cmp-mode-grid").addEventListener("click", () => { s.mode = "grid"; draw(); });
    el.querySelector("#cmp-mode-h2h").addEventListener("click", () => { s.mode = "h2h"; draw(); });
    el.querySelector("#cmp-h2h-a")?.addEventListener("change", (e) => {
      s.h2hA = e.target.value;
      if (s.h2hB === s.h2hA) s.h2hB = "";
      draw();
    });
    el.querySelector("#cmp-h2h-b")?.addEventListener("change", (e) => {
      s.h2hB = e.target.value;
      draw();
    });
  }

  async function loadWeek() {
    s.loading = true; draw();
    try {
      const { data: games, error: gErr } = await supabase.from("games").select("*").eq("week_number", s.week);
      if (gErr) throw gErr;
      s.games = games || [];

      const { data: weekPicks, error: pErr } = await supabase.from("picks").select("*").eq("week_number", s.week);
      if (pErr) throw pErr;
      s.picksByUsername = {};
      for (const p of weekPicks || []) {
        const uname = p.username || "Unknown";
        (s.picksByUsername[uname] ||= []).push(p);
      }

      try {
        const { data: lockRow } = await supabase.from("week_pick_locks").select("*").eq("week_number", s.week).maybeSingle();
        s.weekLock = lockRow || null;
      } catch (_) {
        s.weekLock = null;
      }

      s.loading = false;
      draw();
    } catch (e) {
      s.loading = false;
      s.error = e.message || "Couldn't load this week's picks.";
      draw();
    }
  }

  (async function init() {
    try {
      const { data: rows, error: wErr } = await supabase.from("games").select("week_number");
      if (wErr) throw wErr;
      const weeks = [...new Set((rows || []).map((r) => r.week_number))].sort((a, b) => b - a);
      s.weeks = weeks;
      if (!weeks.length) { s.loading = false; draw(); return; }
      s.week = weeks.includes(s.week) ? s.week : weeks[0];
      setSharedWeek(s.week);
      await loadWeek();
    } catch (e) {
      s.loading = false;
      s.error = e.message || "Couldn't load weeks.";
      draw();
    }
  })();

  draw();
}
