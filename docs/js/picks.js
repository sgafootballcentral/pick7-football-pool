import { escapeHtml } from "./app.js";
import { getSharedWeek, setSharedWeek } from "./weekState.js";
import { pushSupported, getPushState, subscribeToPush, unsubscribeFromPush } from "./push.js";

const EASTERN_TZ = "America/New_York";

// ESPN's scoreboard "dates" param buckets a game by its Eastern calendar
// date, not its raw UTC date -- a night game (e.g. an 8:15pm ET kickoff,
// already past midnight UTC) needs to be queried under the Eastern date, or
// it's silently never found. en-CA gives YYYY-MM-DD ordering directly.
const easternDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: EASTERN_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});
function toEasternDateStr(isoTimestamp) {
  return easternDateFmt.format(new Date(isoTimestamp)).replace(/-/g, "");
}

// Tie-broken by game_id when two or more games share the exact same kickoff
// time (a common noon CFB slot, for instance) -- without a deterministic
// tiebreaker, Postgres/PostgREST don't guarantee row order, so this and the
// Streamlit app's own compute_game_numbers() could each see a different
// tie-break order and number the same game differently.
function gameSortKey(a, b) {
  const t = (a.kickoff_time || "").localeCompare(b.kickoff_time || "");
  if (t !== 0) return t;
  return (a.game_id || "").localeCompare(b.game_id || "");
}

function computeGameNumbers(games) {
  const sorted = [...games].sort(gameSortKey);
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
      .map(toEasternDateStr);
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

// Same sheet as the admin's .xlsx slate export (full grid, thick red line
// between leagues), but as a one-page PDF anyone can download straight from
// the Picks tab. Mirrors the Python version of this in app.py
// (build_slate_pdf): same columns, same "Fit to 1 page" idea (one uniform
// shrink factor, never enlarged, so it's always a single page), same page
// setup Trent already prints this sheet with (landscape Letter, 0.5"
// top/bottom margins, 0.75" left/right, centered horizontally, anchored to
// the top of the page -- not vertically centered).
async function buildSlatePdf(games, weekNumber) {
  const { jsPDF } = await import("https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm");
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });

  const headers = ["#", "FAVORITE", "#", "UNDERDOG", "SPREAD", "KICKOFF (ET)", "TV"];
  const naturalColWidths = [22, 170, 22, 170, 55, 115, 55];
  const naturalTitleH = 22, naturalHeaderH = 18, naturalRowH = 15;
  const titleFont = 14, headerFont = 10, dataFont = 9;

  const sorted = [...games].sort(gameSortKey);
  const n = sorted.length;

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginTop = 0.5 * 72, marginLeft = 0.75 * 72, marginRight = 0.75 * 72;
  const printableW = pageW - marginLeft - marginRight;
  const printableH = pageH - marginTop - 0.5 * 72;

  const naturalW = naturalColWidths.reduce((a, b) => a + b, 0);
  const naturalH = naturalTitleH + naturalHeaderH + n * naturalRowH;
  const scale = Math.min(printableW / naturalW, printableH / Math.max(naturalH, 1), 1);

  const colWidths = naturalColWidths.map((w) => w * scale);
  const titleH = naturalTitleH * scale;
  const headerH = naturalHeaderH * scale;
  const rowH = naturalRowH * scale;
  const tableW = colWidths.reduce((a, b) => a + b, 0);
  const tableH = titleH + headerH + n * rowH;

  const x0 = marginLeft + (printableW - tableW) / 2;
  const yTop = marginTop; // top-anchored -- jsPDF's origin is top-left, unlike reportlab's bottom-left

  function colX(idx) {
    return x0 + colWidths.slice(0, idx).reduce((a, b) => a + b, 0);
  }

  function drawCellText(text, colIdx, rowTop, rowHeight, bold, fontSize, rgb) {
    const size = Math.max(fontSize, 0.5);
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...(rgb || [0, 0, 0]));
    const cx = colX(colIdx) + colWidths[colIdx] / 2;
    const cy = rowTop + rowHeight / 2 + size * 0.35;
    doc.text(String(text), cx, cy, { align: "center" });
  }

  // --- 1. Fills first (header/stripes), so the grid lines below draw on top ---
  doc.setFillColor(0x1f, 0x4e, 0x78);
  doc.rect(x0, yTop + titleH, tableW, headerH, "F");

  let rowTop = yTop + titleH + headerH;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 1) {
      doc.setFillColor(0xf2, 0xf2, 0xf2);
      doc.rect(x0, rowTop, tableW, rowH, "F");
    }
    rowTop += rowH;
  }

  // --- 2. Text ---
  doc.setFont("helvetica", "bold");
  doc.setFontSize(Math.max(titleFont * scale, 0.5));
  doc.setTextColor(0, 0, 0);
  doc.text(`Week ${weekNumber}`, x0 + tableW / 2, yTop + titleH / 2 + titleFont * scale * 0.35, { align: "center" });

  const headerTop = yTop + titleH;
  headers.forEach((h, i) => drawCellText(h, i, headerTop, headerH, true, headerFont * scale, [255, 255, 255]));

  rowTop = headerTop + headerH;
  for (let i = 0; i < n; i++) {
    const g = sorted[i];
    const favNum = 2 * (i + 1) - 1;
    const undNum = 2 * (i + 1);
    let favT = g.favorite_team || "";
    let undT = g.underdog_team || "";
    favT = g.favorite_team_home ? `${favT} (Home)` : favT;
    undT = g.underdog_team_home ? `${undT} (Home)` : undT;
    const spreadParts = (g.spread_value || "").split(" ");
    const spreadNumber = spreadParts[spreadParts.length - 1];

    let kickoffDisplay = g.kickoff_time || "";
    const d = new Date(kickoffDisplay);
    if (!isNaN(d)) {
      const weekday = d.toLocaleDateString("en-US", { weekday: "short", timeZone: EASTERN_TZ });
      const md = d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: EASTERN_TZ });
      const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: EASTERN_TZ });
      kickoffDisplay = `${weekday} ${md} ${time} ET`;
    }

    const tv = g.tv_network || "";
    const values = [favNum, favT, undNum, undT, spreadNumber, kickoffDisplay, tv];
    values.forEach((val, colIdx) => {
      const bold = colIdx === 0 || colIdx === 2;
      drawCellText(val, colIdx, rowTop, rowH, bold, dataFont * scale);
    });
    rowTop += rowH;
  }

  // --- 3. Grid: verticals full height, horizontals thin except a thick red
  // line right where one league's games end and the other's begin ---
  doc.setLineWidth(0.4);
  doc.setDrawColor(0, 0, 0);
  for (let i = 0; i <= headers.length; i++) {
    const x = i < headers.length ? colX(i) : x0 + tableW;
    doc.line(x, yTop, x, yTop + tableH);
  }

  const boundaries = [yTop];
  let y = yTop + titleH;
  boundaries.push(y);
  y += headerH;
  boundaries.push(y);
  for (let i = 0; i < n; i++) {
    y += rowH;
    boundaries.push(y);
  }

  boundaries.forEach((by, idx) => {
    // boundaries[0]=top edge, [1]=title/header, [2]=header/row1, then one per
    // data-row bottom edge -- a league change shows up right after that row,
    // i.e. boundaries[3 + i].
    const dataRowI = idx - 3;
    const isLeagueBoundary = dataRowI >= 0 && dataRowI < n - 1 && sorted[dataRowI].league !== sorted[dataRowI + 1].league;
    if (isLeagueBoundary) {
      doc.setLineWidth(2.2);
      doc.setDrawColor(255, 0, 0);
    } else {
      doc.setLineWidth(0.4);
      doc.setDrawColor(0, 0, 0);
    }
    doc.line(x0, by, x0 + tableW, by);
  });

  return doc;
}

export function renderPicks(el, { supabase, user, username, isAdmin }) {
  const s = {
    loading: true,
    error: "",
    weeks: [],
    week: getSharedWeek(),
    games: [],
    scores: {},
    existingPicks: [],
    selected: {}, // game_id -> team name
    pickResults: {}, // game_id -> "win" | "loss" | null (graded result of that pick, once the admin grades it)
    weekPicksByUsername: {}, // everyone's picks this week, grouped by username -- powers the view-scope selector below
    viewScope: "all", // "all" | "mine" | a specific other player's username
    weekLock: null, // the week_pick_locks row for s.week, or null if no lock is set
    myExceptions: [], // my pick_lock_exceptions rows for s.week, newest first
    exceptionReason: "",
    autoRefresh: false,
    numberInput: "",
    numberError: "",
    preview: null, // {rows, resolved}
    resubmit: null, // {existingMap, newPicks}
    recap: null, // rows
    notifState: "checking",
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

    // \u{1F512} ADMIN PICK LOCK -- mirrors app.py: an admin can freeze all pick
    // submissions/changes for a week starting at a specific time (Admin tab),
    // independent of each game's own kickoff-time lock further below. A
    // player who's locked out can request an exception; once an admin
    // approves it, that player can submit/change picks same as if it weren't
    // locked. isWeekLocked/isEffectivelyLocked below are the source of truth
    // (also used by onLockIn and the resubmit modal); these locals just
    // mirror them for rendering.
    const weekLocked = isWeekLocked();
    const latestException = s.myExceptions[0] || null;
    const hasApprovedException = !!(latestException && latestException.status === "approved");
    const effectivelyLocked = weekLocked && !hasApprovedException;

    // Which games to actually show below: the full slate, just the games
    // you've picked, or -- read-only, and only once a game has kicked off,
    // so nobody can scout a still-editable pick -- another player's picks.
    // otherPlayersSubmitted can only ever list players who've submitted at
    // least one pick this week, so there's no way to pick someone with
    // nothing submitted yet.
    const otherPlayersSubmitted = Object.keys(s.weekPicksByUsername).filter((u) => u !== username).sort();
    let visibleGames = s.games;
    let viewingOtherPlayer = null;
    let otherPicksByGame = {};
    let scopeEmptyMessage = "";
    if (s.viewScope === "mine") {
      const myGameIds = new Set(s.existingPicks.map((p) => p.game_id));
      visibleGames = s.games.filter((g) => myGameIds.has(g.game_id));
      if (!visibleGames.length) scopeEmptyMessage = "You haven't made any picks yet for this week.";
    } else if (s.viewScope !== "all") {
      viewingOtherPlayer = s.viewScope;
      const otherPicks = s.weekPicksByUsername[viewingOtherPlayer] || [];
      otherPicksByGame = Object.fromEntries(otherPicks.map((p) => [p.game_id, p]));
      visibleGames = s.games.filter((g) => g.game_id in otherPicksByGame);
      if (!visibleGames.length) scopeEmptyMessage = `${viewingOtherPlayer} hasn't picked any games yet for this week.`;
    }

    const grouped = {};
    for (const g of [...visibleGames].sort(gameSortKey)) {
      const { dateStr } = formatKickoff(g.kickoff_time);
      (grouped[dateStr] ||= []).push(g);
    }

    function weekLockBannerHtml() {
      if (!weekLocked) return "";
      const lockAtEst = new Date(s.weekLock.lock_at).toLocaleString("en-US", {
        timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      });
      if (hasApprovedException) {
        return `<div class="card" style="border-left:4px solid #2e7d32; margin-bottom:12px;">
          \u{1F513} Picks for Week ${s.week} locked as of ${escapeHtml(lockAtEst)} ET -- but an admin approved an exception for you, so you can still submit or change picks.
        </div>`;
      }
      let extra = "";
      if (latestException && latestException.status === "pending") {
        extra = `<div class="hint" style="margin-top:8px;">⏳ Your exception request is pending admin review.</div>`;
      } else {
        if (latestException && latestException.status === "denied") {
          extra += latestException.denial_reason
            ? `<div class="hint" style="margin-top:8px;">Your last request was denied -- admin note: ${escapeHtml(latestException.denial_reason)}</div>`
            : `<div class="hint" style="margin-top:8px;">Your last request was denied.</div>`;
        }
        extra += `
          <details style="margin-top:8px;">
            <summary class="hint" style="cursor:pointer;">Request an exception</summary>
            <div class="card" style="margin-top:8px;">
              <div class="field">
                <label>Why do you need to submit/change picks after the lock? (optional)</label>
                <textarea id="exception-reason-input" rows="3">${escapeHtml(s.exceptionReason)}</textarea>
              </div>
              <button class="btn btn-secondary" id="request-exception-btn">Request an exception</button>
            </div>
          </details>
        `;
      }
      return `<div class="card" style="border-left:4px solid #c62828; margin-bottom:12px;">
        \u{1F512} Picks for Week ${s.week} are locked as of ${escapeHtml(lockAtEst)} ET. You can't submit or change picks unless an admin approves an exception.
        ${extra}
      </div>`;
    }

    el.innerHTML = `
      <div class="week-select-row">
        <label class="hint" style="white-space:nowrap;">Week:</label>
        <select id="week-select">
          ${s.weeks.map((w) => `<option value="${w}" ${w === s.week ? "selected" : ""}>${w}</option>`).join("")}
        </select>
        <button class="btn btn-secondary" id="pdf-download-btn" style="flex:0 0 auto; width:auto; padding:10px 12px;" title="Download this week's slate as a PDF">⬇️ PDF</button>
      </div>

      ${weekLockBannerHtml()}

      <div class="sticky-bar">
        <div style="text-align:center; font-weight:600;">
          \u{1F3C8} ${count} of 7 games selected
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%;"></div></div>
        </div>
        <div class="btn-row" style="margin-top:8px;">
          <button class="btn btn-primary" id="lock-btn" ${effectivelyLocked ? "disabled" : ""}>Lock In Weekly Picks</button>
          <button class="btn btn-secondary" id="refresh-btn" style="flex:0 0 auto; width:auto; padding:11px 14px;">\u{1F504}</button>
        </div>
        <label class="hint" style="display:flex; align-items:center; gap:6px; margin-top:6px; justify-content:center;">
          <input type="checkbox" id="auto-refresh-toggle" ${s.autoRefresh ? "checked" : ""}> Auto-refresh scores every 60s
        </label>
        <div style="text-align:center; margin-top:6px;">
          <span id="picks-notif-slot">${notifButtonHtml()}</span>
        </div>
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

      <div class="field" style="margin: 14px 0 10px;">
        <label>\u{1F440} Which games would you like to view?</label>
        <select id="view-scope-select">
          <option value="all" ${s.viewScope === "all" ? "selected" : ""}>All games</option>
          <option value="mine" ${s.viewScope === "mine" ? "selected" : ""}>My picks</option>
          ${otherPlayersSubmitted.map((p) => `<option value="${escapeHtml(p)}" ${s.viewScope === p ? "selected" : ""}>${escapeHtml(p)}'s picks</option>`).join("")}
        </select>
      </div>
      ${viewingOtherPlayer ? `<div class="hint" style="margin-bottom:10px;">\u{1F464} Showing ${escapeHtml(viewingOtherPlayer)}'s picks -- revealed only for games that have already kicked off.</div>` : ""}

      ${scopeEmptyMessage ? `<div class="card">${escapeHtml(scopeEmptyMessage)}</div>` : Object.entries(grouped).map(([dateStr, dayGames]) => `
        <div class="day-group">
          <h3>\u{1F4C5} ${dateStr}</h3>
          ${dayGames.map((g) => gameRowHtml(g, s, numbersMap, viewingOtherPlayer, otherPicksByGame)).join("")}
        </div>
      `).join("")}

      <div class="hint" style="margin-top:14px;">Total games selected: <b>${count} / 7</b></div>
    `;

    el.querySelector("#week-select").addEventListener("change", (e) => {
      s.week = Number(e.target.value);
      setSharedWeek(s.week);
      loadWeek();
    });
    el.querySelector("#pdf-download-btn")?.addEventListener("click", onDownloadPdf);
    el.querySelector("#refresh-btn").addEventListener("click", () => loadScoresOnly());
    el.querySelector("#lock-btn").addEventListener("click", onLockIn);
    el.querySelector("#picks-notif-btn")?.addEventListener("click", onToggleNotifications);
    el.querySelector("#auto-refresh-toggle").addEventListener("change", (e) => {
      s.autoRefresh = e.target.checked;
      setupAutoRefresh();
    });
    el.querySelector("#view-scope-select").addEventListener("change", (e) => {
      s.viewScope = e.target.value;
      draw();
    });
    el.querySelector("#number-input").addEventListener("input", (e) => { s.numberInput = e.target.value; });
    el.querySelector("#preview-numbers-btn").addEventListener("click", onPreviewNumbers);
    el.querySelector("#exception-reason-input")?.addEventListener("input", (e) => { s.exceptionReason = e.target.value; });
    el.querySelector("#request-exception-btn")?.addEventListener("click", onRequestException);

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

  function updateNotifButton() {
    const slot = el.querySelector("#picks-notif-slot");
    if (!slot) return; // full draw() hasn't happened yet -- nothing to patch
    slot.innerHTML = notifButtonHtml();
    slot.querySelector("#picks-notif-btn")?.addEventListener("click", onToggleNotifications);
  }

  function notifButtonHtml() {
    if (s.notifState === "unsupported" || s.notifState === "checking") return "";
    if (s.notifState === "denied") {
      return `<span class="hint" style="margin-left:2px;">\u{1F515} Notifications blocked -- enable in browser settings</span>`;
    }
    const on = s.notifState === "subscribed";
    return `<button class="btn btn-secondary" id="picks-notif-btn" style="width:auto; padding:8px 12px;">${on ? "\u{1F514} Notifications on" : "\u{1F515} Enable notifications"}</button>`;
  }

  async function onToggleNotifications() {
    try {
      if (s.notifState === "subscribed") {
        await unsubscribeFromPush(supabase);
        s.notifState = "unsubscribed";
      } else {
        await subscribeToPush(supabase, user.id);
        s.notifState = "subscribed";
      }
      s.error = "";
    } catch (e) {
      s.error = e.message || "Couldn't update notification settings.";
      s.notifState = await getPushState();
    }
    draw();
  }

  function lockedPickHtml(selectedTeam, result) {
    if (!selectedTeam) return `<div class="pick-locked">\u{1F512} Locked -- no pick made</div>`;
    let resultBadge = "";
    if (result === "win") resultBadge = ` <span class="pick-result win">\u2705 Win</span>`;
    else if (result === "loss") resultBadge = ` <span class="pick-result loss">\u274C Loss</span>`;
    return `<div class="pick-locked has-pick">\u{1F512} You picked <b>${escapeHtml(selectedTeam)}</b>${resultBadge}</div>`;
  }

  function otherPlayerPickHtml(g, viewingOtherPlayer, otherPicksByGame, isLocked) {
    // Read-only, and only for games that have actually kicked off -- never
    // reveal another player's still-editable pick, only what they had
    // locked in once it's too late to change anyway.
    if (!isLocked) {
      return `<div class="pick-locked">\u{1F512} Locks at kickoff -- check back after this game starts.</div>`;
    }
    const otherPick = otherPicksByGame[g.game_id];
    const otherTeam = otherPick && otherPick.selected_team;
    if (!otherTeam) return `<div class="pick-locked">No pick found for this game.</div>`;
    let resultBadge = "";
    if (otherPick.result === "win") resultBadge = ` <span class="pick-result win">\u2705 Win</span>`;
    else if (otherPick.result === "loss") resultBadge = ` <span class="pick-result loss">\u274C Loss</span>`;
    return `<div class="pick-locked has-pick">\u{1F464} ${escapeHtml(viewingOtherPlayer)} picked <b>${escapeHtml(otherTeam)}</b>${resultBadge}</div>`;
  }

  function gameRowHtml(g, s, numbersMap, viewingOtherPlayer, otherPicksByGame) {
    const { timeStr } = formatKickoff(g.kickoff_time);
    const now = new Date();
    const kickoff = new Date(g.kickoff_time);
    const isLocked = now >= kickoff;

    const favTeam = g.favorite_team || "Favorite";
    const undTeam = g.underdog_team || "Underdog";
    const favHome = !!g.favorite_team_home;
    const undHome = !!g.underdog_team_home;

    const live = s.scores[g.game_id];
    // lockedLine is what the player actually picks against and what grading
    // uses -- it never changes once synced. liveMarketLine is only ever
    // shown alongside it, labeled, so a mid-week market move never looks
    // like the real number changed.
    const lockedLine = g.spread_value || "0.0";
    let liveMarketLine = null;
    let statusHtml = `<span class="status">\u{1F552} ${timeStr}</span>`;
    let favScoreHtml = "", undScoreHtml = "";

    if (live) {
      // Once the game goes live ESPN typically stops returning this field
      // at all, so it just quietly stops showing rather than snapping back.
      if (live.line && live.line !== "0.0" && live.line !== lockedLine) liveMarketLine = live.line;
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
    } else if (g.status === "final" && g.home_score != null && g.away_score != null) {
      // The live ESPN feed only really has today's/this week's games --
      // looking back at an old, already-graded week falls back to the
      // final score the admin's grading step saved directly on this game,
      // so past weeks don't just show a blank score.
      const favScore = favHome ? g.home_score : g.away_score;
      const undScore = undHome ? g.home_score : g.away_score;
      favScoreHtml = `<span class="score"> ${favScore}</span>`;
      undScoreHtml = `<span class="score"> ${undScore}</span>`;
      statusHtml = `<span class="status">\u{1F3C1} FINAL</span>`;
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
          <div class="spread">${escapeHtml(lockedLine)}${liveMarketLine ? `<div class="spread-live">Now: ${escapeHtml(liveMarketLine)}</div>` : ""}</div>
          ${statusHtml}
        </div>
        <div class="pick-choices">
          ${viewingOtherPlayer ? otherPlayerPickHtml(g, viewingOtherPlayer, otherPicksByGame, isLocked) : (isLocked ? lockedPickHtml(selectedTeam, s.pickResults[g.game_id]) : `
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
          `)}
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
      if (isEffectivelyLocked()) {
        alert("\u{1F512} Picks for this week are locked. Request an exception if you need to submit or change your picks.");
        return;
      }
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
    s.pickResults = {};
    for (const p of s.existingPicks) s.pickResults[p.game_id] = p.result;
    draw();
  }

  function isWeekLocked() {
    if (!s.weekLock?.lock_at) return false;
    return new Date() >= new Date(s.weekLock.lock_at);
  }

  function isEffectivelyLocked() {
    if (!isWeekLocked()) return false;
    const latest = s.myExceptions[0];
    return !(latest && latest.status === "approved");
  }

  async function onRequestException() {
    await supabase.from("pick_lock_exceptions").insert({
      week_number: s.week, user_id: user.id, username,
      reason: s.exceptionReason.trim() || null,
    });
    s.exceptionReason = "";
    const { data } = await supabase.from("pick_lock_exceptions").select("*")
      .eq("week_number", s.week).eq("user_id", user.id).order("requested_at", { ascending: false });
    s.myExceptions = data || [];
    draw();
  }

  async function onDownloadPdf() {
    const btn = el.querySelector("#pdf-download-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Building\u2026"; }
    try {
      const doc = await buildSlatePdf(s.games, s.week);
      doc.save(`week_${s.week}_slate.pdf`);
    } catch (e) {
      alert("Couldn't build the PDF: " + (e.message || e));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "\u2b07\ufe0f PDF"; }
    }
  }

  async function onLockIn() {
    if (isEffectivelyLocked()) {
      alert("\u{1F512} Picks for this week are locked. Request an exception if you need to submit or change your picks.");
      return;
    }
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

      // One query for everyone's picks this week, same idea as the Streamlit
      // app -- existingPicks (mine) is filtered out of it below, and the
      // rest powers the "view someone else's picks" selector. This used to
      // silently swallow a query error (a failed/empty result looked
      // identical to "nobody's picked yet"), which made a real problem here
      // look exactly like normal, empty data -- log it now so it's visible
      // in the console instead of just quietly showing nothing.
      const { data: weekPicks, error: pErr } = await supabase.from("picks").select("*").eq("week_number", s.week);
      if (pErr) console.error("Couldn't load this week's picks:", pErr);
      const weekPicksAll = weekPicks || [];
      s.existingPicks = weekPicksAll.filter((p) => p.user_id === user.id);
      s.pickResults = {};
      for (const p of s.existingPicks) {
        s.selected[p.game_id] = p.selected_team;
        s.pickResults[p.game_id] = p.result;
      }
      s.weekPicksByUsername = {};
      for (const p of weekPicksAll) {
        const uname = p.username || "Unknown";
        (s.weekPicksByUsername[uname] ||= []).push(p);
      }
      s.viewScope = "all"; // reset on every week switch/reload, same as the Streamlit app

      // \u{1F512} Admin pick lock for this week, and my own exception requests
      // against it (if any) -- see the ADMIN PICK LOCK block in draw().
      try {
        const { data: lockRow } = await supabase.from("week_pick_locks").select("*").eq("week_number", s.week).maybeSingle();
        s.weekLock = lockRow || null;
      } catch (_) {
        s.weekLock = null;
      }
      try {
        const { data: exceptions } = await supabase.from("pick_lock_exceptions").select("*")
          .eq("week_number", s.week).eq("user_id", user.id).order("requested_at", { ascending: false });
        s.myExceptions = exceptions || [];
      } catch (_) {
        s.myExceptions = [];
      }

      s.scores = await fetchLiveScores(s.games);
      s.loading = false;
      draw();
    } catch (e) {
      s.loading = false;
      s.error = e.message || "Couldn't load this week's games.";
      draw();
    }
  }

  if (pushSupported()) {
    getPushState().then((st) => { s.notifState = st; updateNotifButton(); });
  } else {
    s.notifState = "unsupported";
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

  // Clean up the interval if this tab's DOM gets replaced by a re-render elsewhere.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      if (autoTimer) clearInterval(autoTimer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
