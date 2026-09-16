import { escapeHtml } from "./app.js";

const EASTERN_TZ = "America/New_York";
let weekCache = null; // persists the selected week across tab switches in one session

function computeGameNumbers(games) {
  const sorted = [...games].sort((a, b) => (a.kickoff_time || "").localeCompare(b.kickoff_time || ""));
  const numbers = {};
  sorted.forEach((g, i) => {
    numbers[g.game_id] = { favNum: 2 * (i + 1) - 1, undNum: 2 * (i + 1) };
  });
  return numbers;
}

async function fetchLiveScores(games) {
  const url = window.APP_CONFIG.LIVE_SCORES_URL;
  if (!url || url.includes("YOUR-PROJECT-REF")) return {};

  const byLeague = {};
  for (const g of games) {
    if (!g.league) continue;
    (byLeague[g.league] ||= []).push(g);
  }

  const params = new URLSearchParams();
  for (const [league, list] of Object.entries(byLeague)) {
    const dates = list
      .map((g) => g.kickoff_time)
      .filter(Boolean)
      .map((t) => t.slice(0, 10).replace(/-/g, ""));
    if (!dates.length) continue;
    const min = dates.reduce((a, b) => (a < b ? a : b));
    const max = dates.reduce((a, b) => (a > b ? a : b));
    params.set(`${league.toLowerCase()}_dates`, `${min}-${max}`);
  }
  if (![...params.keys()].length) return {};

  try {
    const resp = await fetch(`${url}?${params.toString()}`, {
      headers: {
        apikey: window.APP_CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${window.APP_CONFIG.SUPABASE_ANON_KEY}`,
      },
    });
    if (!resp.ok) return {};
    const data = await resp.json();
    return data.scores || {};
  } catch (_) {
    return {};
  }
}

function formatKickoff(iso) {
  const d = new Date(iso);
  const dateStr = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: EASTERN_TZ });
  const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: EASTERN_TZ }) + " ET";
  return { dateStr, timeStr };
}

export function renderPicks(el, { supabase, user, username, isAdmin }) {
  const s = {
    loading: true,
    error: "",
    weeks: [],
    week: weekCache,
    games: [],
    scores: {},
    existingPicks: [],
    selected: {}, // game_id -> team name
    autoRefresh: false,
    numberInput: "",
    numberError: "",
    preview: null, // {rows, resolved}
    resubmit: null, // {existingMap, newPicks}
    recap: null, // rows
  };

  let autoTimer = null;

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
      el.innerHTML = `<div class="card">No games have been loaded yet. Check back once the games are set up.</div>`;
      return;
    }

    const count = Object.keys(s.selected).length;
    const pct = Math.min((count / 7) * 100, 100);
    const numbersMap = computeGameNumbers(s.games);

    const grouped = {};
    for (const g of [...s.games].sort((a, b) => a.kickoff_time.localeCompare(b.kickoff_time))) {
      const { dateStr } = formatKickoff(g.kickoff_time);
      (grouped[dateStr] ||= []).push(g);
    }

    el.innerHTML = `
      <div class="week-select-row">
        <label class="hint" style="white-space:nowrap;">Week:</label>
        <select id="week-select">
          ${s.weeks.map((w) => `<option value="${w}" ${w === s.week ? "selected" : ""}>${w}</option>`).join("")}
        </select>
      </div>

      <div class="sticky-bar">
        <div style="text-align:center; font-weight:600;">
          \u{1F3C8} ${count} of 7 games selected
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%;"></div></div>
        </div>
        <div class="btn-row" style="margin-top:8px;">
          <button class="btn btn-primary" id="lock-btn">Lock In Weekly Picks</button>
          <button class="btn btn-secondary" id="refresh-btn" style="flex:0 0 auto; width:auto; padding:11px 14px;">\u{1F504}</button>
        </div>
        <label class="hint" style="display:flex; align-items:center; gap:6px; margin-top:6px; justify-content:center;">
          <input type="checkbox" id="auto-refresh-toggle" ${s.autoRefresh ? "checked" : ""}> Auto-refresh scores every 60s
        </label>
      </div>

      <details style="margin: 10px 0;">
        <summary class="hint" style="cursor:pointer;">\u{1F522} Enter your picks by number instead</summary>
        <div class="card" style="margin-top:8px;">
          <div class="field">
            <label>Your 7 picks, comma-separated (e.g. 1,5,9,12,23,78,100)</label>
            <input type="text" id="number-input" value="${escapeHtml(s.numberInput)}" placeholder="1,5,9,12,23,78,100">
          </div>
          ${s.numberError ? `<div class="error-msg">${escapeHtml(s.numberError)}</div>` : ""}
          <button class="btn btn-secondary" id="preview-numbers-btn">Preview My Picks</button>
        </div>
      </details>

      ${Object.entries(grouped).map(([dateStr, dayGames]) => `
        <div class="day-group">
          <h3>\u{1F4C5} ${dateStr}</h3>
          ${dayGames.map((g) => gameRowHtml(g, s, numbersMap)).join("")}
        </div>
      `).join("")}

      <div class="hint" style="margin-top:14px;">Total games selected: <b>${count} / 7</b></div>
    `;

    el.querySelector("#week-select").addEventListener("change", (e) => {
      s.week = Number(e.target.value);
      weekCache = s.week;
      loadWeek();
    });
    el.querySelector("#refresh-btn").addEventListener("click", () => loadScoresOnly());
    el.querySelector("#lock-btn").addEventListener("click", onLockIn);
    el.querySelector("#auto-refresh-toggle").addEventListener("change", (e) => {
      s.autoRefresh = e.target.checked;
      setupAutoRefresh();
    });
    el.querySelector("#number-input").addEventListener("input", (e) => { s.numberInput = e.target.value; });
    el.querySelector("#preview-numbers-btn").addEventListener("click", onPreviewNumbers);

    el.querySelectorAll("[data-pick-game]").forEach((input) => {
      // "click" (not "change") on purpose -- clicking an already-checked
      // radio never fires "change" (its checked state doesn't move), so
      // there was no way to back out of a game once picked short of
      // immediately choosing the other team in it. Treat a click on the
      // currently-selected option as "clear this pick" instead.
      input.addEventListener("click", (e) => {
        const gid = e.target.dataset.pickGame;
        const team = e.target.value;
        if (s.selected[gid] === team) {
          delete s.selected[gid];
          draw();
          return;
        }
        if (count >= 7 && !(gid in s.selected)) {
          e.preventDefault();
          return; // capped client-side too
        }
        s.selected[gid] = team;
        draw();
      });
    });

    // Guard against duplicate modals: a background auto-refresh redraw
    // (or any other draw() call) while a modal is already open must not
    // stack a second copy on top of it.
    const modalAlreadyOpen = !!document.querySelector(".modal-backdrop");
    if (s.preview && !modalAlreadyOpen) drawPreviewModal();
    if (s.resubmit && !modalAlreadyOpen) drawResubmitModal();
    if (s.recap && !modalAlreadyOpen) drawRecapModal();
  }

  function gameRowHtml(g, s, numbersMap) {
    const { timeStr } = formatKickoff(g.kickoff_time);
    const now = new Date();
    const kickoff = new Date(g.kickoff_time);
    const isLocked = now >= kickoff;

    const favTeam = g.favorite_team || "Favorite";
    const undTeam = g.underdog_team || "Underdog";
    const favHome = !!g.favorite_team_home;
    const undHome = !!g.underdog_team_home;

    const live = s.scores[g.game_id];
    let line = g.spread_value || "0.0";
    let statusHtml = `<span class="status">\u{1F552} ${timeStr}</span>`;
    let favScoreHtml = "", undScoreHtml = "";

    if (live) {
      if (live.line && live.line !== "0.0") line = live.line;
      const favScore = favHome ? live.home_score : live.away_score;
      const undScore = undHome ? live.home_score : live.away_score;
      if (live.completed) {
        favScoreHtml = `<span class="score"> ${favScore}</span>`;
        undScoreHtml = `<span class="score"> ${undScore}</span>`;
        statusHtml = `<span class="status">\u{1F3C1} FINAL</span>`;
      } else if (live.state === "in") {
        favScoreHtml = `<span class="score"> ${favScore}</span>`;
        undScoreHtml = `<span class="score"> ${undScore}</span>`;
        statusHtml = `<span class="status live">\u{1F534} LIVE - ${escapeHtml(live.clock || "")}</span>`;
      } else if (/DELAY|POSTPON|SUSPEND|CANCEL/.test(live.status_name || "")) {
        statusHtml = `<span class="status">⏳ ${escapeHtml(live.clock || "Delayed")}</span>`;
      }
    }

    const graded = g.status === "final" && g.winning_team;
    const favCovered = graded && g.winning_team === favTeam;
    const undCovered = graded && g.winning_team === undTeam;

    const nums = numbersMap[g.game_id] || {};
    const selectedTeam = s.selected[g.game_id];
    const isEmpty = !selectedTeam;
    const capReached = Object.keys(s.selected).length >= 7;
    const disable = capReached && isEmpty;

    return `
      <div class="game-row">
        <div class="matchup">
          <div class="${favCovered ? "covered" : ""}"><span class="team">#${nums.favNum || ""} ${escapeHtml(favTeam)}${favHome ? " \u{1F3E0}" : ""}</span>${favScoreHtml}${favCovered ? " ✅" : ""}</div>
          <div class="${undCovered ? "covered" : ""}"><span class="team">#${nums.undNum || ""} ${escapeHtml(undTeam)}${undHome ? " \u{1F3E0}" : ""}</span>${undScoreHtml}${undCovered ? " ✅" : ""}</div>
          <div class="spread">${escapeHtml(line)}</div>
          ${statusHtml}
        </div>
        <div class="pick-choices">
          ${isLocked ? `<div class="pick-locked">\u{1F512} Locked</div>` : `
            <label class="pick-choice ${selectedTeam === favTeam ? "selected" : ""}">
              <input type="radio" name="pick_${g.game_id}" data-pick-game="${g.game_id}" value="${escapeHtml(favTeam)}"
                ${selectedTeam === favTeam ? "checked" : ""} ${disable && selectedTeam !== favTeam ? "disabled" : ""}>
              ${escapeHtml(favTeam)}
            </label>
            <label class="pick-choice ${selectedTeam === undTeam ? "selected" : ""}">
              <input type="radio" name="pick_${g.game_id}" data-pick-game="${g.game_id}" value="${escapeHtml(undTeam)}"
                ${selectedTeam === undTeam ? "checked" : ""} ${disable && selectedTeam !== undTeam ? "disabled" : ""}>
              ${escapeHtml(undTeam)}
            </label>
          `}
        </div>
      </div>
    `;
  }

  function drawPreviewModal() {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <div class="modal-sheet">
        <h2>\u{1F522} Confirm Your Picks</h2>
        <p class="hint">You are submitting picks for Week ${s.week}. Here's what these numbers resolve to:</p>
        ${s.preview.rows.map((r) => `<div class="card" style="padding:10px 12px; margin-bottom:6px;">
          <b>#${r.num}</b> ${escapeHtml(r.team)} — ${escapeHtml(r.matchup)} <span class="hint">(${escapeHtml(r.spread)})</span>
        </div>`).join("")}
        <div class="btn-row" style="margin-top:10px;">
          <button class="btn btn-primary" id="apply-numbers-btn">✅ Apply These Picks</button>
          <button class="btn btn-secondary" id="cancel-numbers-btn">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    wrap.querySelector("#apply-numbers-btn").addEventListener("click", () => {
      for (const item of s.preview.resolved) s.selected[item.game_id] = item.team;
      s.preview = null;
      wrap.remove();
      draw();
    });
    wrap.querySelector("#cancel-numbers-btn").addEventListener("click", () => {
      s.preview = null;
      wrap.remove();
    });
  }

  function drawResubmitModal() {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    const gameLookup = Object.fromEntries(s.games.map((g) => [g.game_id, g]));
    const existingMap = Object.fromEntries(s.resubmit.existingPicks.map((p) => [p.game_id, p.selected_team]));
    const newMap = s.resubmit.newPicks;
    const allIds = new Set([...Object.keys(existingMap), ...Object.keys(newMap)]);
    const rows = [...allIds].map((gid) => {
      const g = gameLookup[gid] || {};
      return {
        matchup: `${g.favorite_team || ""} vs ${g.underdog_team || gid}`,
        onFile: existingMap[gid] || "—",
        newPick: newMap[gid] || "—",
        changed: existingMap[gid] !== newMap[gid],
      };
    });

    wrap.innerHTML = `
      <div class="modal-sheet">
        <h2>⚠️ You've Already Submitted This Week</h2>
        <p class="hint">Here's how your on-file picks compare to your new selections:</p>
        ${rows.map((r) => `<div class="card" style="padding:10px 12px; margin-bottom:6px;">
          <div style="font-size:0.85rem;">${escapeHtml(r.matchup)}</div>
          <div style="font-size:0.85rem; margin-top:4px;">On File: <b>${escapeHtml(r.onFile)}</b> &rarr; New: <b>${escapeHtml(r.newPick)}</b> ${r.changed ? "\u{1F504}" : ""}</div>
        </div>`).join("")}
        <p>Replace your on-file picks with the new selections above?</p>
        <div class="btn-row">
          <button class="btn btn-primary" id="confirm-resubmit-btn">Yes, resubmit</button>
          <button class="btn btn-secondary" id="cancel-resubmit-btn">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    wrap.querySelector("#confirm-resubmit-btn").addEventListener("click", async () => {
      await submitPicks();
      s.resubmit = null;
      wrap.remove();
    });
    wrap.querySelector("#cancel-resubmit-btn").addEventListener("click", () => {
      s.resubmit = null;
      wrap.remove();
    });
  }

  function drawRecapModal() {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <div class="modal-sheet">
        <h2>\u{1F512} Your Picks Are Locked In!</h2>
        <p class="hint">Here's what you picked for this week:</p>
        ${s.recap.map((r) => `<div class="card" style="padding:10px 12px; margin-bottom:6px;">
          <b>${escapeHtml(r.selected_team)}</b> — ${escapeHtml(r.matchup)} <span class="hint">(${escapeHtml(r.spread)})</span>
        </div>`).join("")}
        <button class="btn btn-primary" id="recap-ok-btn">Got it!</button>
      </div>
    `;
    document.body.appendChild(wrap);
    wrap.querySelector("#recap-ok-btn").addEventListener("click", () => {
      s.recap = null;
      wrap.remove();
    });
  }

  function onPreviewNumbers() {
    s.numberError = "";
    const parts = s.numberInput.split(",").map((p) => p.trim()).filter(Boolean);
    let entered;
    try {
      entered = parts.map((p) => { const n = Number(p); if (!Number.isInteger(n)) throw new Error(); return n; });
    } catch {
      s.numberError = "Please enter numbers only, separated by commas.";
      draw();
      return;
    }

    const numbersMap = computeGameNumbers(s.games);
    const lookup = {};
    for (const g of s.games) {
      const nums = numbersMap[g.game_id];
      lookup[nums.favNum] = { gameId: g.game_id, team: g.favorite_team };
      lookup[nums.undNum] = { gameId: g.game_id, team: g.underdog_team };
    }

    const invalid = [...new Set(entered.filter((n) => !lookup[n]))];
    const dupes = [...new Set(entered.filter((n) => entered.filter((x) => x === n).length > 1))];
    const now = new Date();
    const locked = entered.filter((n) => {
      const info = lookup[n];
      if (!info) return false;
      const g = s.games.find((x) => x.game_id === info.gameId);
      return g && now >= new Date(g.kickoff_time);
    });

    if (invalid.length) s.numberError = `These numbers don't match any game this week: ${invalid.join(", ")}`;
    else if (dupes.length) s.numberError = `These numbers were entered more than once: ${dupes.join(", ")}`;
    else if (locked.length) s.numberError = `These games have already started and can't be picked: ${locked.join(", ")}`;
    else if (entered.length !== 7) s.numberError = `You entered ${entered.length} number(s) -- exactly 7 are required.`;
    else {
      const gameLookup = Object.fromEntries(s.games.map((g) => [g.game_id, g]));
      const rows = entered.map((n) => {
        const info = lookup[n];
        const g = gameLookup[info.gameId];
        return { num: n, team: info.team, matchup: `${g.favorite_team} vs ${g.underdog_team}`, spread: g.spread_value || "" };
      });
      const resolved = entered.map((n) => ({ game_id: lookup[n].gameId, team: lookup[n].team }));
      s.preview = { rows, resolved };
    }
    draw();
  }

  async function submitPicks() {
    const gameLookup = Object.fromEntries(s.games.map((g) => [g.game_id, g]));
    await supabase.from("picks").delete().eq("user_id", user.id).eq("week_number", s.week);
    const rows = Object.entries(s.selected).map(([gameId, team]) => ({
      user_id: user.id, username, week_number: s.week,
      game_id: gameId, selected_team: team,
      spread_at_pick: gameLookup[gameId]?.spread_value || "",
    }));
    for (const row of rows) {
      await supabase.from("picks").insert(row);
    }
    // One row per submission event (not per pick) -- a Database Webhook on
    // this table's INSERT is what triggers the admin push notification,
    // see supabase/functions/send-picks-push. Non-critical if it fails --
    // the picks themselves are already saved above.
    try {
      await supabase.from("pick_submissions").insert({
        user_id: user.id, username, week_number: s.week, picks_count: rows.length,
      });
    } catch (_) { /* non-critical */ }
    s.recap = rows.map((r) => ({
      selected_team: r.selected_team,
      matchup: `${gameLookup[r.game_id]?.favorite_team || ""} vs ${gameLookup[r.game_id]?.underdog_team || r.game_id}`,
      spread: gameLookup[r.game_id]?.spread_value || "",
    }));
    const { data } = await supabase.from("picks").select("*").eq("user_id", user.id).eq("week_number", s.week);
    s.existingPicks = data || [];
    draw();
  }

  async function onLockIn() {
    const count = Object.keys(s.selected).length;
    if (count !== 7) {
      s.error = "";
      alert("You must pick exactly 7 games.");
      return;
    }
    if (s.existingPicks.length) {
      s.resubmit = { existingPicks: s.existingPicks, newPicks: { ...s.selected } };
      draw();
    } else {
      await submitPicks();
    }
  }

  async function loadScoresOnly() {
    s.scores = await fetchLiveScores(s.games);
    draw();
  }

  function setupAutoRefresh() {
    if (autoTimer) clearInterval(autoTimer);
    if (s.autoRefresh) autoTimer = setInterval(loadScoresOnly, 60000);
  }

  async function loadWeek() {
    s.loading = true; draw();
    try {
      const { data: games, error: gErr } = await supabase.from("games").select("*").eq("week_number", s.week);
      if (gErr) throw gErr;
      s.games = games || [];
      s.selected = {};

      const { data: picks } = await supabase.from("picks").select("*").eq("user_id", user.id).eq("week_number", s.week);
      s.existingPicks = picks || [];
      for (const p of s.existingPicks) s.selected[p.game_id] = p.selected_team;

      s.scores = await fetchLiveScores(s.games);
      s.loading = false;
      draw();
    } catch (e) {
      s.loading = false;
      s.error = e.message || "Couldn't load this week's games.";
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
      weekCache = s.week;
      await loadWeek();
    } catch (e) {
      s.loading = false;
      s.error = e.message || "Couldn't load weeks.";
      draw();
    }
  })();

  draw();

  // Clean up the interval if this tab's DOM gets replaced by a re-render elsewhere.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      if (autoTimer) clearInterval(autoTimer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
