import { supabase } from "./supabaseClient.js";
import { renderAuth } from "./auth.js";
import { renderPicks } from "./picks.js";
import { renderLeaderboard } from "./leaderboard.js";
import { renderCompare } from "./compare.js";
import { renderChat } from "./chat.js";
import { renderRequestsVotes } from "./requestsVotes.js";
import { renderSetNewPassword } from "./recovery.js";
import { pushSupported, getPushState, subscribeToPush, unsubscribeFromPush } from "./push.js";

const root = document.getElementById("app");

const state = {
  session: null,
  user: null,
  username: null,
  avatarUrl: null,
  avatarMonogram: null,
  isAdmin: false,
  activeTab: "picks",
  deferredInstallPrompt: null,
  installBannerDismissed: sessionStorage.getItem("installBannerDismissed") === "1",
  recoveryMode: false,
  lastChatReadAt: null,
  hasUnreadChat: false,
  dmReadsByOther: {}, // other_id -> last_read_at, for DMs I've opened
  unreadDmSenders: {}, // sender_id -> true, for senders with an unread DM to me
  hasUnreadDm: false,
  notifState: "checking",
  currentSeason: null, // { id, year, label }
  playerSeasonActive: true, // am I opted in to the current season
  currentLeague: null, // { id, name, invite_code, role }
  userLeagues: [], // every league I belong to
  isSuperAdmin: false, // the original global admin flag -- admin of every league automatically
};

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  state.deferredInstallPrompt = e;
  render();
});

window.addEventListener("online", render);
window.addEventListener("offline", render);

async function refreshIdentity() {
  const { data: { session } } = await supabase.auth.getSession();
  state.session = session;
  state.user = session?.user ?? null;

  if (!state.user) {
    state.username = null;
    state.avatarUrl = null;
    state.avatarMonogram = null;
    state.isAdmin = false;
    state.isSuperAdmin = false;
    state.currentSeason = null;
    state.playerSeasonActive = true;
    state.currentLeague = null;
    state.userLeagues = [];
    return;
  }

  const signupUsername = state.user.user_metadata?.username || state.user.email;
  const signupFullName = state.user.user_metadata?.full_name || "";

  // Mirror the Streamlit app's own behavior, and its fix for the same bug:
  // don't blindly overwrite an existing players row on every login, or a
  // rename an admin made would get reverted back to the signup-time name
  // the very next time this player logs in. Same idea for full_name -- only
  // ever backfill it if it's missing, never stomp an admin correction.
  try {
    const { data: existingPlayerRows } = await supabase.from("players").select("username, full_name, avatar_url, avatar_monogram").eq("id", state.user.id);
    if (existingPlayerRows && existingPlayerRows.length) {
      state.username = existingPlayerRows[0].username || signupUsername;
      state.avatarUrl = existingPlayerRows[0].avatar_url || null;
      state.avatarMonogram = existingPlayerRows[0].avatar_monogram || null;
      if (!existingPlayerRows[0].full_name && signupFullName) {
        try {
          await supabase.from("players").update({ full_name: signupFullName }).eq("id", state.user.id);
        } catch (_) { /* non-critical */ }
      }
    } else {
      state.username = signupUsername;
      state.avatarUrl = null;
      state.avatarMonogram = null;
      await supabase.from("players").insert({ id: state.user.id, username: state.username, full_name: signupFullName || null });
    }
  } catch (_) {
    state.username = signupUsername; // non-critical -- don't block the session over this
    state.avatarUrl = null;
    state.avatarMonogram = null;
  }

  await refreshLeagues();
  await refreshLeagueAdmin();

  await refreshLastChatReadAt();

  try {
    const { data } = await supabase.from("dm_reads").select("other_id, last_read_at").eq("user_id", state.user.id);
    state.dmReadsByOther = {};
    for (const r of data || []) state.dmReadsByOther[r.other_id] = r.last_read_at;
  } catch (_) {
    state.dmReadsByOther = {};
  }

  await refreshCurrentSeason();
}

// Every league I belong to (league_members joined to leagues), with my role
// in each. Resolves state.currentLeague -- remembered across visits via
// localStorage, same idea as "remember me" for login, falling back to the
// first league if nothing's remembered yet or I'm no longer in it.
async function refreshLeagues() {
  try {
    const { data } = await supabase
      .from("league_members")
      .select("league_id, role, leagues(id, name, invite_code)")
      .eq("user_id", state.user.id);
    state.userLeagues = (data || [])
      .filter((r) => r.leagues)
      .map((r) => ({ id: r.leagues.id, name: r.leagues.name, invite_code: r.leagues.invite_code, role: r.role }));
  } catch (_) {
    state.userLeagues = [];
  }

  if (!state.userLeagues.length) {
    state.currentLeague = null;
    return;
  }

  let rememberedId = null;
  try { rememberedId = localStorage.getItem("pick7_current_league_id"); } catch (_) { /* non-critical */ }
  state.currentLeague =
    state.userLeagues.find((l) => String(l.id) === String(rememberedId)) || state.userLeagues[0];
  try { localStorage.setItem("pick7_current_league_id", state.currentLeague.id); } catch (_) { /* non-critical */ }
}

// Switches the active league (from the switcher, or right after creating/
// joining one), persists the choice, and reloads everything that's scoped
// to a league -- admin status, current season, and a full re-render.
async function setCurrentLeague(leagueId) {
  const found = state.userLeagues.find((l) => String(l.id) === String(leagueId));
  if (!found) return;
  state.currentLeague = found;
  try { localStorage.setItem("pick7_current_league_id", found.id); } catch (_) { /* non-critical */ }
  await refreshLeagueAdmin();
  await refreshCurrentSeason();
  await refreshLastChatReadAt();
  await checkUnreadChat();
  render();
}

// Mirrors the is_league_admin() SQL function: a global league_users
// super-admin is admin of every league automatically; otherwise it's just
// whatever role league_members gave me in the current league (already
// fetched by refreshLeagues(), so no extra query needed for that half).
async function refreshLeagueAdmin() {
  try {
    const { data } = await supabase.from("league_users").select("role").eq("id", state.user.id).single();
    state.isSuperAdmin = data?.role === "admin";
  } catch (_) {
    state.isSuperAdmin = false;
  }
  state.isAdmin = state.isSuperAdmin || state.currentLeague?.role === "admin";
}

// Loads the current season (for the current league) and whether I'm opted
// in to it. Defaults to "playing" (true) whenever there's no row yet, since
// the season migration backfilled every existing player as active=true -- a
// missing row only happens for a brand new signup made after the opt-out
// toggle shipped, and new signups should start out playing too.
async function refreshCurrentSeason() {
  if (!state.currentLeague) {
    state.currentSeason = null;
    state.playerSeasonActive = true;
    return;
  }

  try {
    const { data: season } = await supabase
      .from("seasons")
      .select("id, year, label, pick_count_mode, pick_count_exact, sync_leagues, season_weeks, default_lock_offset_minutes")
      .eq("league_id", state.currentLeague.id)
      .eq("is_current", true)
      .single();
    state.currentSeason = season || null;
  } catch (_) {
    state.currentSeason = null;
  }

  if (!state.currentSeason) {
    state.playerSeasonActive = true;
    return;
  }

  try {
    const { data } = await supabase
      .from("player_seasons")
      .select("active")
      .eq("season_id", state.currentSeason.id)
      .eq("user_id", state.user.id)
      .maybeSingle();
    state.playerSeasonActive = data ? data.active : true;
  } catch (_) {
    state.playerSeasonActive = true;
  }
}

// Loads this user's last-read-chat timestamp for the current league from
// chat_reads (a per-league table, replacing the old flat
// players.last_chat_read_at column) -- called on initial identity load and
// again whenever the active league changes, since the timestamp is now
// scoped per league rather than global.
async function refreshLastChatReadAt() {
  try {
    if (!state.currentLeague) throw new Error("no league");
    const { data } = await supabase
      .from("chat_reads")
      .select("last_read_at")
      .eq("user_id", state.user.id)
      .eq("league_id", state.currentLeague.id)
      .maybeSingle();
    state.lastChatReadAt = data?.last_read_at || null;
  } catch (_) {
    state.lastChatReadAt = null;
  }
}

// Lightweight poll for new chat activity -- independent of whether the Chat
// tab is mounted, so the bottom-nav badge stays accurate no matter which
// tab a player is looking at. Never counts a player's own messages as
// "unread", and never flags unread while the Chat tab is already open.
async function checkUnreadChat() {
  if (!state.user || !state.currentLeague) return;
  try {
    const { data } = await supabase
      .from("chat_messages")
      .select("created_at,user_id")
      .eq("league_id", state.currentLeague.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (!data) return;
    const isMine = data.user_id === state.user.id;
    const isNew = !state.lastChatReadAt || new Date(data.created_at) > new Date(state.lastChatReadAt);
    const nowUnread = !isMine && isNew && state.activeTab !== "chat";
    if (nowUnread !== state.hasUnreadChat) {
      state.hasUnreadChat = nowUnread;
      render();
    }
  } catch (_) {
    /* non-critical */
  }
}

async function markChatRead() {
  if (!state.user || !state.currentLeague) return;
  state.hasUnreadChat = false;
  const nowIso = new Date().toISOString();
  state.lastChatReadAt = nowIso;
  try {
    await supabase.from("chat_reads").upsert(
      { user_id: state.user.id, league_id: state.currentLeague.id, last_read_at: nowIso },
      { onConflict: "user_id,league_id" }
    );
  } catch (_) {
    /* non-critical */
  }
}

// Lightweight poll for unread DMs, same idea as checkUnreadChat -- runs
// independent of which tab is open so the Standings nav badge is accurate.
// Looks at recent incoming messages (capped, this is a small private pool)
// and reduces to "most recent message per sender" client-side, since the
// Supabase JS client has no group-by.
async function checkUnreadDm() {
  if (!state.user) return;
  try {
    const { data } = await supabase
      .from("direct_messages")
      .select("sender_id, created_at")
      .eq("recipient_id", state.user.id)
      .order("created_at", { ascending: false })
      .limit(200);
    const latestBySender = {};
    for (const m of data || []) {
      if (!(m.sender_id in latestBySender)) latestBySender[m.sender_id] = m.created_at;
    }
    const unread = {};
    for (const [senderId, createdAt] of Object.entries(latestBySender)) {
      const lastRead = state.dmReadsByOther[senderId];
      if (!lastRead || new Date(createdAt) > new Date(lastRead)) unread[senderId] = true;
    }
    state.unreadDmSenders = unread;
    const nowUnread = Object.keys(unread).length > 0;
    if (nowUnread !== state.hasUnreadDm) {
      state.hasUnreadDm = nowUnread;
      render();
    }
  } catch (_) {
    /* non-critical */
  }
}

// Marks one DM thread as read -- called when the player opens it from the
// Standings profile sheet. Upserts rather than insert/update because this
// is the first time this pair has ever had a read row.
async function markDmRead(otherId) {
  if (!state.user || !otherId) return;
  const nowIso = new Date().toISOString();
  state.dmReadsByOther[otherId] = nowIso;
  if (state.unreadDmSenders[otherId]) {
    delete state.unreadDmSenders[otherId];
    state.hasUnreadDm = Object.keys(state.unreadDmSenders).length > 0;
    render();
  }
  try {
    await supabase.from("dm_reads").upsert({ user_id: state.user.id, other_id: otherId, last_read_at: nowIso });
  } catch (_) {
    /* non-critical */
  }
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Once a week's games have all been graded, shows each player a one-time
// "here's where you stand" popup the next time they log in -- their
// record for that week, their season record, their current place, and
// how their place moved since the week before. Tracked per-player on
// players.last_recap_season_id/last_recap_week_seen so it only ever shows
// once per newly-completed week, never on an interval/poll like the
// unread-chat/DM checks above.
async function checkWeekRecap() {
  if (!state.user || !state.currentSeason) return;
  const seasonId = state.currentSeason.id;
  try {
    const { data: games } = await supabase.from("games").select("week_number, status").eq("season_id", seasonId);
    const statusesByWeek = {};
    for (const g of games || []) (statusesByWeek[g.week_number] ||= []).push(g.status);
    const completedWeeks = Object.entries(statusesByWeek)
      .filter(([, statuses]) => statuses.length > 0 && statuses.every((st) => st === "final"))
      .map(([wk]) => Number(wk))
      .sort((a, b) => a - b);
    if (!completedWeeks.length) return;
    const completedWeek = completedWeeks[completedWeeks.length - 1];

    const { data: playerRow } = await supabase.from("players")
      .select("last_recap_season_id, last_recap_week_seen")
      .eq("id", state.user.id).single();
    if (playerRow && playerRow.last_recap_season_id === seasonId && (playerRow.last_recap_week_seen || 0) >= completedWeek) {
      return; // already shown this week's recap
    }

    const { data: tallies } = await supabase.from("picks_week_tallies")
      .select("user_id, week_number, wins, losses")
      .eq("season_id", seasonId);
    const rows = tallies || [];

    // Standings "as of" a given week -- same rank-with-ties logic as the
    // Standings tab (1-2-2-4), just scoped to whatever weeks are <= maxWeek
    // so it can be reused for both "now" and "as of last week" (the trend).
    function standingsThrough(maxWeek) {
      const byPlayer = {};
      for (const r of rows) {
        if (r.week_number > maxWeek) continue;
        const rec = (byPlayer[r.user_id] ||= { user_id: r.user_id, wins: 0, losses: 0 });
        rec.wins += r.wins;
        rec.losses += r.losses;
      }
      const list = Object.values(byPlayer).filter((r) => r.wins + r.losses > 0);
      list.sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses));
      let lastWins = null, lastPlace = 0;
      list.forEach((r, i) => { if (r.wins !== lastWins) { lastPlace = i + 1; lastWins = r.wins; } r.place = lastPlace; });
      return list;
    }

    const nowStandings = standingsThrough(completedWeek);
    const myNow = nowStandings.find((r) => r.user_id === state.user.id);
    if (!myNow) return; // haven't got a graded pick yet -- nothing to show

    const priorWeek = completedWeeks.filter((w) => w < completedWeek).pop();
    let trend = { kind: "new" };
    if (priorWeek != null) {
      const myPrior = standingsThrough(priorWeek).find((r) => r.user_id === state.user.id);
      if (myPrior) {
        const delta = myPrior.place - myNow.place;
        trend = delta > 0 ? { kind: "up", amount: delta } : delta < 0 ? { kind: "down", amount: -delta } : { kind: "same" };
      } else {
        trend = { kind: "new" };
      }
    }

    const weekRecord = rows
      .filter((r) => r.user_id === state.user.id && r.week_number === completedWeek)
      .reduce((acc, r) => ({ wins: acc.wins + r.wins, losses: acc.losses + r.losses }), { wins: 0, losses: 0 });

    showWeekRecapModal({
      week: completedWeek,
      weekRecord,
      seasonRecord: { wins: myNow.wins, losses: myNow.losses },
      place: myNow.place,
      totalPlayers: nowStandings.length,
      trend,
    });

    try {
      await supabase.from("players").update({
        last_recap_season_id: seasonId, last_recap_week_seen: completedWeek,
      }).eq("id", state.user.id);
    } catch (_) { /* non-critical */ }
  } catch (_) {
    /* non-critical -- never block login over this */
  }
}

function showWeekRecapModal(info) {
  if (document.querySelector(".modal-backdrop")) return; // don't stack on top of another modal
  const { week, weekRecord, seasonRecord, place, totalPlayers, trend } = info;

  const trendHtml =
    trend.kind === "up" ? `<span class="rank-chip up">▲${trend.amount}</span> climbed ${trend.amount} spot${trend.amount === 1 ? "" : "s"} from last week`
    : trend.kind === "down" ? `<span class="rank-chip down">▼${trend.amount}</span> slipped ${trend.amount} spot${trend.amount === 1 ? "" : "s"} from last week`
    : trend.kind === "same" ? `<span class="rank-chip same">–</span> holding steady vs. last week`
    : `<span class="rank-chip same">NEW</span> your first ranked week this season`;

  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.innerHTML = `
    <div class="modal-sheet">
      <h3 style="text-align:center; margin-top:0;">\u{1F3C8} Week ${week} Recap</h3>
      <div class="card" style="text-align:center; margin-bottom:12px;">
        <div class="hint">Week ${week} record</div>
        <div style="font-size:1.6rem; font-weight:700;">${weekRecord.wins}–${weekRecord.losses}</div>
      </div>
      <div class="card" style="text-align:center; margin-bottom:12px;">
        <div class="hint">Season record</div>
        <div style="font-size:1.6rem; font-weight:700;">${seasonRecord.wins}–${seasonRecord.losses}</div>
      </div>
      <div class="card" style="text-align:center; margin-bottom:12px;">
        <div class="hint">Current place</div>
        <div style="font-size:1.6rem; font-weight:700;">${ordinal(place)} <span class="hint" style="font-size:1rem; font-weight:400;">of ${totalPlayers}</span></div>
        <div class="hint" style="margin-top:4px;">${trendHtml}</div>
      </div>
      <button class="btn btn-primary" id="week-recap-close-btn">Nice!</button>
    </div>
  `;
  document.body.appendChild(wrap);
  wrap.querySelector("#week-recap-close-btn").addEventListener("click", () => wrap.remove());
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    state.recoveryMode = true;
    render();
    return;
  }
  state.session = session;
  state.user = session?.user ?? null;
  if (state.user && !state.recoveryMode) {
    refreshIdentity().then(() => { render(); checkUnreadChat(); checkUnreadDm(); checkWeekRecap(); });
  } else if (!state.user) {
    state.hasUnreadChat = false;
    state.lastChatReadAt = null;
    state.hasUnreadDm = false;
    state.unreadDmSenders = {};
    state.dmReadsByOther = {};
    state.username = null;
    state.avatarUrl = null;
    state.avatarMonogram = null;
    state.isAdmin = false;
    state.isSuperAdmin = false;
    state.currentSeason = null;
    state.playerSeasonActive = true;
    state.currentLeague = null;
    state.userLeagues = [];
    render();
  }
});

function renderChrome(innerHtml) {
  const offline = !navigator.onLine;
  const showInstall =
    !state.installBannerDismissed &&
    !isStandalone() &&
    !state.recoveryMode &&
    (state.deferredInstallPrompt || isIOS());

  root.innerHTML = `
    ${offline ? `<div class="offline-banner">You're offline -- showing the last data that loaded.</div>` : ""}
    ${showInstall ? `
      <div class="install-banner">
        <span>${isIOS()
          ? "Install this app: tap the Share icon, then “Add to Home Screen.”"
          : "Install Pick 7 to your home screen for quick access."}</span>
        <span style="display:flex; gap:6px; align-items:center;">
          ${!isIOS() ? `<button class="btn btn-primary" id="install-btn" style="width:auto; padding:6px 10px;">Install</button>` : ""}
          <button class="close" id="dismiss-install" aria-label="Dismiss">&times;</button>
        </span>
      </div>` : ""}
    ${state.user && !state.recoveryMode ? `
      <div class="topbar">
        <button class="avatar-btn" id="account-menu-btn" aria-label="Account menu" title="${escapeHtml(state.username || "")}">
          ${avatarInnerHtml(state.avatarUrl, state.avatarMonogram, state.username)}
        </button>
        ${state.currentLeague ? `
          <button class="league-pill" id="league-switcher-btn" aria-label="Switch league">
            \u{1F3C8} ${escapeHtml(state.currentLeague.name)} <span class="chev">\u25BE</span>
          </button>
        ` : `<span></span>`}
      </div>
    ` : ""}
    <div id="tab-content">${innerHtml}</div>
    ${state.user && !state.recoveryMode ? `
      <nav class="bottom-nav">
        <button data-tab="picks" class="${state.activeTab === "picks" ? "active" : ""}">
          <span class="icon">\u{1F3C8}</span>Picks
        </button>
        <button data-tab="leaderboard" class="${state.activeTab === "leaderboard" ? "active" : ""}">
          <span class="icon">\u{1F3C6}</span>Standings
          ${state.hasUnreadDm ? `<span class="nav-badge"></span>` : ""}
        </button>
        <button data-tab="compare" class="${state.activeTab === "compare" ? "active" : ""}">
          <span class="icon">\u{1F19A}</span>Compare
        </button>
        <button data-tab="chat" class="${state.activeTab === "chat" ? "active" : ""}">
          <span class="icon">\u{1F4AC}</span>Chat
          ${state.hasUnreadChat ? `<span class="nav-badge"></span>` : ""}
        </button>
        <button data-tab="requests" class="${state.activeTab === "requests" ? "active" : ""}">
          <span class="icon">\u{1F5F3}\uFE0F</span>Requests
        </button>
      </nav>
    ` : ""}
  `;

  document.getElementById("dismiss-install")?.addEventListener("click", () => {
    state.installBannerDismissed = true;
    sessionStorage.setItem("installBannerDismissed", "1");
    render();
  });
  document.getElementById("install-btn")?.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    render();
  });
  document.getElementById("account-menu-btn")?.addEventListener("click", openAccountMenu);
  document.getElementById("league-switcher-btn")?.addEventListener("click", openLeagueSwitcher);
  root.querySelectorAll(".bottom-nav [data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      if (state.activeTab === "chat") markChatRead();
      render();
    });
  });
}

function buildAdminUrl() {
  const base = window.APP_CONFIG.ADMIN_URL;
  const accessToken = state.session?.access_token;
  const refreshToken = state.session?.refresh_token;
  if (!accessToken) return base; // no live session yet -- fall back to a plain link, Streamlit just shows its own login

  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}admin_sso_at=${encodeURIComponent(accessToken)}&admin_sso_rt=${encodeURIComponent(refreshToken || "")}`;
}

// username -> avatar_url for every player, used wherever someone else's
// avatar needs to show (leaderboard, chat, compare) -- "players readable
// by all" makes this a safe single-table select, no join needed.
export async function fetchAvatarsByUsername(supabase) {
  const { data } = await supabase.from("players").select("username, avatar_url, avatar_monogram");
  const map = {};
  (data || []).forEach((p) => {
    if (p.username) map[p.username] = { url: p.avatar_url || null, monogram: p.avatar_monogram || null };
  });
  return map;
}

// user_id -> current display name, for anywhere that groups or labels
// picks/messages by player but only has a (possibly stale) snapshot
// username on the row itself. Resolving through this instead of trusting
// that snapshot means a rename can never split or orphan someone's
// history again, whether or not any backfill of the old rows succeeded.
export async function fetchCurrentUsernames(supabase) {
  const { data } = await supabase.from("players").select("id, username");
  const map = {};
  (data || []).forEach((p) => { if (p.id) map[p.id] = p.username || null; });
  return map;
}

function initialOf(name) {
  const n = (name || "").trim();
  return n ? n.charAt(0).toUpperCase() : "?";
}

export function avatarInnerHtml(url, monogram, name) {
  if (url) return `<img src="${escapeHtml(url)}" alt="">`;
  const letters = (monogram || "").trim().toUpperCase();
  if (letters) {
    // However many letters someone picks, they all render at the same
    // size -- just dialed down as a group so 2-3 characters still fit the
    // circle instead of one letter being bigger than the rest.
    const scale = letters.length <= 1 ? 1 : letters.length === 2 ? 0.62 : 0.48;
    return `<span style="font-size:${scale}em; letter-spacing:0.02em;">${escapeHtml(letters)}</span>`;
  }
  return `<span>${escapeHtml(initialOf(name))}</span>`;
}

const GC_EASTERN_TZ = "America/New_York";
// ESPN's scoreboard "dates" param buckets a game by its Eastern calendar
// date, not its raw UTC date -- a night game (e.g. an 8:15pm ET kickoff,
// already past midnight UTC) needs to be queried under the Eastern date, or
// it's silently never found. en-CA gives YYYY-MM-DD ordering directly.
// (Mirrors the identical helper that already lives in picks.js -- kept
// separate rather than imported from there so this module has no
// dependency on picks.js, just the other way around.)
const gcEasternDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: GC_EASTERN_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});
function gcToEasternDateStr(isoTimestamp) {
  return gcEasternDateFmt.format(new Date(isoTimestamp)).replace(/-/g, "");
}

export function formatKickoff(iso) {
  const d = new Date(iso);
  const dateStr = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: GC_EASTERN_TZ });
  const timeStr = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: GC_EASTERN_TZ }) + " ET";
  return { dateStr, timeStr };
}

// Shared ESPN live-score fetch, used by both picks.js (which has its own
// near-identical copy wired into its own refresh loop -- left alone to
// avoid touching working code) and leaderboard.js's week-picks popup,
// which has no live-score fetching of its own otherwise. Keyed by
// game_id the same way picks.js's own copy is, and tolerant of a missing
// or placeholder LIVE_SCORES_URL the same way too.
export async function fetchLiveScores(games) {
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
      .map(gcToEasternDateStr);
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

// ESPN-gamecast-style detail popup for a single game -- team logos, score,
// live clock/quarter + down-and-distance + a simple field-position bar
// while in progress, and a quarter-by-quarter line score once there's at
// least one quarter on the board. `live` is one entry from fetchLiveScores()
// (or undefined/empty if scores haven't loaded / ESPN had nothing for this
// game yet) -- every section below is optional and just doesn't render
// when the data for it isn't there, rather than showing a blank/broken row.
export function openGameDetailModal(game, live) {
  live = live || {};
  const homeIsFavorite = !!game.favorite_team_home;
  const homeTeam = homeIsFavorite ? game.favorite_team : game.underdog_team;
  const awayTeam = homeIsFavorite ? game.underdog_team : game.favorite_team;

  const isFinal = live.completed || (game.status === "final" && game.home_score != null);
  const isLive = live.state === "in" && !isFinal;
  const homeScore = live.home_score ?? game.home_score;
  const awayScore = live.away_score ?? game.away_score;
  const hasScore = homeScore != null && awayScore != null && (isLive || isFinal);

  const { dateStr, timeStr } = formatKickoff(game.kickoff_time);

  let centerHtml;
  if (isLive) {
    centerHtml = `
      <div class="gc-clock">${escapeHtml(live.clock || "LIVE")}</div>
      ${live.period ? `<div class="gc-period">${ordinalPeriod(live.period)}</div>` : ""}
    `;
  } else if (isFinal) {
    centerHtml = `<div class="gc-clock">FINAL</div>`;
  } else {
    centerHtml = `<div class="gc-clock">${escapeHtml(timeStr)}</div><div class="gc-period">${escapeHtml(dateStr)}</div>`;
  }

  const situationHtml = isLive && (live.down_distance_text || live.possession_text)
    ? `
      <div class="gc-situation ${live.is_redzone ? "gc-redzone" : ""}">
        ${live.down_distance_text ? `<div class="gc-situation-main">${escapeHtml(live.down_distance_text)}</div>` : ""}
        ${live.possession_text ? `<div class="gc-situation-sub">${escapeHtml(live.possession_text)}</div>` : ""}
      </div>
      ${typeof live.yard_line === "number" ? fieldBarHtml(live.yard_line, live.possession_side) : ""}
    `
    : "";

  const hasLinescores = Array.isArray(live.home_linescores) && Array.isArray(live.away_linescores)
    && (live.home_linescores.length > 0 || live.away_linescores.length > 0);
  const linescoreHtml = hasLinescores ? linescoreTableHtml(live, awayTeam, homeTeam, homeIsFavorite) : "";

  const metaRows = [];
  if (!isLive && !isFinal) metaRows.push(["Kickoff", `${dateStr} · ${timeStr}`]);
  if (live.broadcasts?.length) metaRows.push(["Broadcast", live.broadcasts.join(", ")]);
  else if (game.tv_network) metaRows.push(["Broadcast", game.tv_network]);
  if (live.venue) metaRows.push(["Venue", `${live.venue.name}${live.venue.city ? ` — ${live.venue.city}${live.venue.state ? `, ${live.venue.state}` : ""}` : ""}`]);
  // ESPN's weather.display is sometimes just a bare number (not actual
  // conditions text, e.g. humidity or cloud cover with no label) -- when
  // that's all there is, showing it next to temperature reads as a
  // confusing second, unexplained number, so only tack it on when it's
  // not itself just a number.
  if (live.weather?.display || live.weather?.temperature != null) {
    const d = live.weather?.display || "";
    const isBareNumber = /^\d+$/.test(d.trim());
    const tempPart = live.weather?.temperature != null ? `${live.weather.temperature}°` : "";
    const descPart = d && !isBareNumber ? d : "";
    metaRows.push(["Weather", [tempPart, descPart].filter(Boolean).join(" · ")]);
  }
  const spreadLine = game.spread_value || live.line;
  if (spreadLine) metaRows.push(["Spread", spreadLine]);

  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.innerHTML = `
    <div class="modal-sheet gc-sheet">
      <button class="modal-close-x" id="gc-close-x" aria-label="Close">&times;</button>
      <div class="gc-teams">
        ${gcTeamHtml(awayTeam, live.away_logo, awayScore, live.away_record, hasScore)}
        <div class="gc-center">${centerHtml}</div>
        ${gcTeamHtml(homeTeam, live.home_logo, homeScore, live.home_record, hasScore)}
      </div>
      ${situationHtml}
      ${linescoreHtml}
      ${metaRows.length ? `
        <div class="gc-meta">
          ${metaRows.map(([label, val]) => `<div class="gc-meta-row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(val)}</span></div>`).join("")}
        </div>
      ` : ""}
      <button class="btn btn-secondary" id="gc-close-btn" style="margin-top:14px;">Close</button>
    </div>
  `;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector("#gc-close-x").addEventListener("click", close);
  wrap.querySelector("#gc-close-btn").addEventListener("click", close);
  wrap.querySelectorAll("[data-open-team-schedule]").forEach((teamEl) => {
    teamEl.addEventListener("click", () => {
      const teamName = teamEl.dataset.openTeamSchedule;
      if (teamName) openTeamScheduleModal(teamName, game.league, seasonYearFromKickoff(game.kickoff_time), game.season_id ?? null);
    });
  });
}

function ordinalPeriod(n) {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  if (n === 4) return "4th";
  return n > 4 ? (n === 5 ? "OT" : `${n - 4}OT`) : `${n}th`;
}

function gcTeamHtml(name, logo, score, record, hasScore) {
  // Clickable (to pull up that team's schedule) only once there's an
  // actual team to look up -- "TBD" placeholder slots for a not-yet-set
  // matchup have nothing to show.
  const clickable = !!name && name !== "TBD";
  return `
    <div class="gc-team${clickable ? " gc-team-clickable" : ""}"${clickable ? ` data-open-team-schedule="${escapeHtml(name)}"` : ""}>
      ${logo ? `<img class="gc-logo" src="${escapeHtml(logo)}" alt="">` : `<div class="gc-logo gc-logo-fallback">${escapeHtml((name || "?").charAt(0))}</div>`}
      ${hasScore ? `<div class="gc-score">${escapeHtml(String(score))}</div>` : ""}
      <div class="gc-team-name">${escapeHtml(name || "TBD")}</div>
      ${record ? `<div class="gc-team-record">${escapeHtml(record)}</div>` : ""}
    </div>
  `;
}

// Simple, honest approximation of ESPN's field-position bar: not an exact
// visual match (it doesn't flip which end is which based on home/away),
// just "how far the possessing team has driven toward the end zone
// they're attacking," which is what the down/distance + possession text
// above it already communicates in words.
function fieldBarHtml(yardLine, possessionSide) {
  const pct = Math.max(2, Math.min(98, yardLine));
  return `
    <div class="gc-fieldbar">
      <div class="gc-fieldbar-track">
        <div class="gc-fieldbar-arrow ${possessionSide || ""}" style="left:${pct}%;">▶</div>
      </div>
      <div class="gc-fieldbar-ticks"><span>20</span><span>50</span><span>20</span></div>
    </div>
  `;
}

function linescoreTableHtml(live, awayTeam, homeTeam, homeIsFavorite) {
  const awayScores = live.away_linescores || [];
  const homeScores = live.home_linescores || [];
  const periods = Math.max(awayScores.length, homeScores.length, 4);
  const headers = Array.from({ length: periods }, (_, i) => (i < 4 ? String(i + 1) : (i === 4 ? "OT" : `${i - 3}OT`)));
  const awayLogo = live.away_logo, homeLogo = live.home_logo;
  const rowHtml = (name, logo, perPeriod, total) => `
    <tr>
      <td class="gc-ls-team">${logo ? `<img src="${escapeHtml(logo)}" alt="">` : ""}${escapeHtml(name || "")}</td>
      ${headers.map((_, i) => `<td>${perPeriod[i] != null ? escapeHtml(String(perPeriod[i])) : "–"}</td>`).join("")}
      <td class="gc-ls-total">${total != null ? escapeHtml(String(total)) : "–"}</td>
    </tr>
  `;
  const sumOrNull = (arr) => (arr.length ? arr.reduce((a, b) => a + (Number(b) || 0), 0) : null);
  return `
    <table class="gc-linescore">
      <thead><tr><th></th>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}<th>T</th></tr></thead>
      <tbody>
        ${rowHtml(awayTeam, awayLogo, awayScores, live.away_score ?? sumOrNull(awayScores))}
        ${rowHtml(homeTeam, homeLogo, homeScores, live.home_score ?? sumOrNull(homeScores))}
      </tbody>
    </table>
  `;
}

// CFB/NFL seasons span two calendar years (a season that starts in August
// finishes with January bowls/playoffs the following year), and ESPN's
// `season` query param wants the year the season is labeled by -- so a
// January/February kickoff belongs to the PREVIOUS calendar year's season.
function seasonYearFromKickoff(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const m = d.getUTCMonth(); // 0 = Jan
  return m <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

// Server-side proxy to ESPN's own team-schedule API (see
// supabase/functions/get-team-schedule) -- unlike fetchLiveScores() above,
// which only covers whatever games are already in this pool's `games`
// table, this returns a team's FULL season, including weeks this pool
// hasn't synced yet.
async function fetchTeamSchedule(teamName, league, seasonYear) {
  const url = window.APP_CONFIG.TEAM_SCHEDULE_URL;
  if (!url || url.includes("YOUR-PROJECT-REF") || !teamName) return null;
  const params = new URLSearchParams({ team: teamName, league: (league || "cfb").toLowerCase() });
  if (seasonYear) params.set("season", String(seasonYear));
  try {
    const resp = await fetch(`${url}?${params.toString()}`, {
      headers: {
        apikey: window.APP_CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${window.APP_CONFIG.SUPABASE_ANON_KEY}`,
      },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null;
  }
}

// Turns one of ESPN's own schedule events into a game-shaped object good
// enough for openGameDetailModal() and teamScheduleRowHtml() to treat
// exactly like a real row from our `games` table -- so every row in the
// schedule list is click-through-able the same way, whether or not this
// pool ever included that particular game. There's no real point-spread
// "favorite" here (ESPN's basic schedule endpoint doesn't carry odds), so
// favorite_team is just set to whichever side is actually home; it only
// ever controls left/right display order, and spread_value is left blank
// so no spread row renders for it.
function syntheticGameFromEspn(eg, teamName, league) {
  const opponent = eg.opponent || "TBD";
  const isLive = eg.state === "in" && !eg.completed;
  return {
    game_id: `espn_${eg.espn_id}`,
    league,
    week_number: eg.week_number,
    kickoff_time: eg.kickoff_time,
    status: eg.completed ? "final" : isLive ? "in_progress" : "scheduled",
    favorite_team: eg.home ? teamName : opponent,
    underdog_team: eg.home ? opponent : teamName,
    // `favorite_team` above is ALWAYS assigned to whichever side is
    // actually home (teamName when this team hosted, the opponent when it
    // didn't) -- so this flag must always point at that same slot.
    // Setting it to `eg.home` instead (whether THIS team specifically is
    // home) broke every synthesized AWAY game: e.g. Boston College's loss
    // at Cincinnati (BC 15, Cincinnati 34) got favorite_team="Cincinnati"
    // with favorite_team_home=false, which flipped teamScheduleRowHtml's
    // isHome math and displayed it as a 34-15 BC win.
    favorite_team_home: true,
    home_score: eg.home ? eg.team_score : eg.opp_score,
    away_score: eg.home ? eg.opp_score : eg.team_score,
    spread_value: null,
    tv_network: eg.broadcasts?.[0] || null,
    season_id: null,
  };
}

// Tapping a team's name/logo in the gamecast popup (any of the places that
// popup opens -- Picks, Standings' week-picks drill-down, Compare) opens
// that team's full schedule. ESPN's own schedule is the source of truth
// for *which* games exist and in what order -- this pool's own `games`
// table only has whatever weeks have been synced so far, which is why an
// earlier version of this looked incomplete. A row that matches a game
// already in this pool still uses that real row (so it keeps its actual
// spread and TV info); every other row is synthesized from ESPN alone.
// Either way the row opens the same gamecast popup, with a fresh live/final
// score fetched only for the one game actually clicked.
async function openTeamScheduleModal(teamName, league, seasonYear, localSeasonId) {
  const panel = document.createElement("div");
  panel.className = "modal-backdrop";
  document.body.appendChild(panel);
  const close = () => panel.remove();

  panel.innerHTML = `
    <div class="modal-sheet">
      <button class="modal-close-x" id="team-sched-x-btn" aria-label="Close">&times;</button>
      <h3 style="text-align:center; margin-top:0;">${escapeHtml(teamName)} -- Schedule</h3>
      <div class="hint" style="text-align:center;">Loading…</div>
    </div>
  `;
  panel.querySelector("#team-sched-x-btn").addEventListener("click", close);

  try {
    // Two separate eq() queries rather than one .or() -- team names can
    // contain characters (periods, parentheses, ampersands) that aren't
    // safe to drop straight into a PostgREST .or() filter string.
    let favQuery = supabase.from("games").select("*").eq("favorite_team", teamName);
    let dogQuery = supabase.from("games").select("*").eq("underdog_team", teamName);
    if (localSeasonId != null) {
      favQuery = favQuery.eq("season_id", localSeasonId);
      dogQuery = dogQuery.eq("season_id", localSeasonId);
    }
    const [{ data: asFav }, { data: asDog }, scheduleResp] = await Promise.all([
      favQuery,
      dogQuery,
      fetchTeamSchedule(teamName, league, seasonYear),
    ]);

    const localByEspnId = {};
    for (const g of [...(asFav || []), ...(asDog || [])]) {
      const m = /^espn_(.+)$/.exec(g.game_id || "");
      if (m) localByEspnId[m[1]] = g;
    }

    const espnGames = scheduleResp?.games || [];
    // ESPN lookup can come back empty (a team name this pool uses that
    // ESPN's teams list doesn't resolve, or ESPN itself hiccupping) --
    // fall back to whatever this pool already has on file so the popup
    // still shows *something* rather than nothing.
    const games = espnGames.length
      ? espnGames.map((eg) => localByEspnId[eg.espn_id] || syntheticGameFromEspn(eg, teamName, league))
      : Object.values(localByEspnId).sort((a, b) => (a.kickoff_time || "").localeCompare(b.kickoff_time || ""));
    const gamesById = Object.fromEntries(games.map((g) => [g.game_id, g]));

    panel.innerHTML = `
      <div class="modal-sheet">
        <button class="modal-close-x" id="team-sched-x-btn" aria-label="Close">&times;</button>
        <h3 style="text-align:center; margin-top:0;">${escapeHtml(teamName)} -- Schedule</h3>
        ${games.length ? games.map((g) => teamScheduleRowHtml(g, teamName)).join("") : `<div class="hint" style="text-align:center;">No schedule found for ${escapeHtml(teamName)}.</div>`}
        <button class="btn btn-secondary" id="team-sched-close-btn" style="margin-top:10px;">Close</button>
      </div>
    `;
    panel.querySelector("#team-sched-x-btn").addEventListener("click", close);
    panel.querySelector("#team-sched-close-btn").addEventListener("click", close);
    panel.querySelectorAll("[data-open-gamecard]").forEach((rowEl) => {
      rowEl.addEventListener("click", async () => {
        const gid = rowEl.dataset.openGamecard;
        const g = gamesById[gid];
        if (!g) return;
        // Lazy, per-click live-score fetch -- no need to pull live data
        // for every game in the schedule just to show a static list.
        let live = {};
        try {
          live = (await fetchLiveScores([g]))[gid] || {};
        } catch (_) {
          live = {};
        }
        openGameDetailModal(g, live);
      });
    });
  } catch (e) {
    panel.innerHTML = `
      <div class="modal-sheet">
        <button class="modal-close-x" id="team-sched-x-btn" aria-label="Close">&times;</button>
        <h3 style="text-align:center; margin-top:0;">${escapeHtml(teamName)} -- Schedule</h3>
        <div class="error-msg" style="text-align:center;">Couldn't load schedule: ${escapeHtml(e.message || String(e))}</div>
        <button class="btn btn-secondary" id="team-sched-close-btn" style="margin-top:10px;">Close</button>
      </div>
    `;
    panel.querySelector("#team-sched-x-btn").addEventListener("click", close);
    panel.querySelector("#team-sched-close-btn").addEventListener("click", close);
  }
}

function teamScheduleRowHtml(g, teamName) {
  const isHome = g.favorite_team === teamName ? !!g.favorite_team_home : !g.favorite_team_home;
  const opponent = g.favorite_team === teamName ? g.underdog_team : g.favorite_team;

  const isFinal = g.status === "final" && g.home_score != null;
  const isLive = g.status === "in_progress" && !isFinal;
  const teamScore = isHome ? g.home_score : g.away_score;
  const oppScore = isHome ? g.away_score : g.home_score;
  const hasScore = teamScore != null && oppScore != null && (isFinal || isLive);

  const resultClass = isFinal && hasScore ? (teamScore > oppScore ? "win" : teamScore < oppScore ? "loss" : "") : "";
  const resultLabel = isFinal && hasScore ? (teamScore > oppScore ? "W" : teamScore < oppScore ? "L" : "T") : "";

  const { dateStr, timeStr } = formatKickoff(g.kickoff_time);
  const statusLabel = isFinal ? "Final" : isLive ? "Live" : `${dateStr} · ${timeStr}`;

  return `
    <div class="game-card" style="margin-bottom:7px;">
      <div class="game-card-stripe ${resultClass}"></div>
      <div class="game-card-body">
        <div class="game-card-top game-card-clickable" data-open-gamecard="${escapeHtml(g.game_id)}">
          <div class="game-card-matchup">${g.week_number != null ? `Wk ${escapeHtml(String(g.week_number))}: ` : ""}${isHome ? "vs" : "@"} ${escapeHtml(opponent || "TBD")}</div>
          <div class="game-card-meta"><span class="spread">${escapeHtml(g.spread_value || "")}</span></div>
        </div>
        <div class="game-card-pickrow ${resultClass === "win" ? "win-bg" : ""}">
          <span class="label">${escapeHtml(statusLabel)}</span>
          <span class="value ${resultClass}">${hasScore ? `${resultLabel ? `${resultLabel} ` : ""}${teamScore}-${oppScore}` : "—"}</span>
        </div>
      </div>
    </div>
  `;
}

// ===== Shared player-profile popup (Compare + Chat tabs) =====
// Mirrors the profile sheet / week-picks drill-down / DM thread already
// built into leaderboard.js's Standings tab. leaderboard.js keeps its own
// copy rather than switching to this one -- it already has every player's
// full-season picks loaded for the podium/trend logic, plus a trend chip
// this version doesn't compute, so re-deriving that here would be wasted
// work and a regression risk for no benefit (same "don't touch a tab's
// already-working copy" split used for fetchLiveScores/formatKickoff
// above). Compare and Chat had no profile popup of their own, so they call
// this self-contained version instead: it fetches whatever it needs
// itself (just this one player's picks), rather than depending on the
// caller having preloaded every player's data.
let profileModalState = null; // { userId, username, seasonId, avatarsByUsername, wrap }
let profileDmState = null; // { otherId, otherUsername, avatarsByUsername, messages, loading, error, wrap, timer }

export async function openPlayerProfileModal(userId, username, avatarsByUsername, seasonId) {
  closePlayerProfileModal();
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  const isMe = userId === state.user?.id;
  wrap.innerHTML = `
    <div class="modal-sheet">
      <div class="profile-head">
        <span class="avatar-circle-lg profile-avatar-xl">${avatarInnerHtml(avatarsByUsername?.[username]?.url, avatarsByUsername?.[username]?.monogram, username)}</span>
        <h2 style="margin:0;">${escapeHtml(username)}${isMe ? ` <span class="hint">(you)</span>` : ""}</h2>
        <div class="hint" id="profile-record-line">Loading…</div>
      </div>
      <div id="profile-weeks-slot"><div class="centered" style="min-height:0; padding:14px 0;"><div class="loading-spinner"></div></div></div>
      <div class="btn-row" style="margin-top:14px;">
        ${!isMe ? `<button class="btn btn-primary" id="profile-message-btn">\u{1F4AC} Message ${escapeHtml(username)}</button>` : ""}
        <button class="btn btn-secondary" id="profile-close-btn">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  profileModalState = { userId, username, seasonId, avatarsByUsername, wrap };

  wrap.querySelector("#profile-close-btn").addEventListener("click", closePlayerProfileModal);
  wrap.querySelector("#profile-message-btn")?.addEventListener("click", () => {
    closePlayerProfileModal();
    openPlayerDmThread(userId, username, avatarsByUsername);
  });

  try {
    let picksQuery = supabase.from("picks").select("week_number, result").eq("user_id", userId);
    if (seasonId != null) picksQuery = picksQuery.eq("season_id", seasonId);
    const { data: picks, error } = await picksQuery;
    if (error) throw error;

    const byWeek = {};
    let wins = 0, losses = 0;
    for (const p of picks || []) {
      if (p.result !== "win" && p.result !== "loss") continue;
      const wk = (byWeek[p.week_number] ||= { wins: 0, losses: 0 });
      if (p.result === "win") { wk.wins++; wins++; } else { wk.losses++; losses++; }
    }
    const weeks = Object.keys(byWeek).map(Number).sort((a, b) => a - b).map((wn) => ({ week_number: wn, ...byWeek[wn] }));

    if (!profileModalState || profileModalState.wrap !== wrap) return; // closed/replaced while this was loading
    const pct = wins + losses ? ((wins / (wins + losses)) * 100).toFixed(1) : "0.0";
    wrap.querySelector("#profile-record-line").textContent = `${wins}–${losses} overall · ${pct}% win rate`;
    wrap.querySelector("#profile-weeks-slot").innerHTML = weeks.length ? `
      <table class="profile-weeks">
        <thead><tr><th>Week</th><th>W</th><th>L</th></tr></thead>
        <tbody>${weeks.map((w) => `<tr class="standings-clickable" data-week="${w.week_number}"><td>${w.week_number}</td><td>${w.wins}</td><td>${w.losses}</td></tr>`).join("")}</tbody>
      </table>
      <div class="hint" style="text-align:center; margin-top:6px;">Tap a week to see those picks.</div>
    ` : `<div class="hint" style="text-align:center;">No graded weeks yet.</div>`;
    wrap.querySelectorAll("tr[data-week]").forEach((row) => {
      row.addEventListener("click", () => {
        openPlayerWeekPicksModal(userId, username, Number(row.dataset.week), seasonId, wrap);
      });
    });
  } catch (e) {
    if (!profileModalState || profileModalState.wrap !== wrap) return;
    wrap.querySelector("#profile-record-line").textContent = "";
    wrap.querySelector("#profile-weeks-slot").innerHTML = `<div class="error-msg" style="text-align:center;">Couldn't load this player's picks: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

function closePlayerProfileModal() {
  profileModalState?.wrap?.remove();
  profileModalState = null;
}

// Same drill-down a week row opens from leaderboard.js's own profile sheet
// -- matchup, picked team, spread, graded result, with a click-through to
// the gamecast popup for any game in the list.
async function openPlayerWeekPicksModal(userId, uname, weekNumber, seasonId, profileWrap) {
  const panel = document.createElement("div");
  panel.className = "modal-backdrop";
  document.body.appendChild(panel);

  // The X goes all the way back to the profile sheet's caller -- it closes
  // both this popup and the profile sheet underneath it, not just itself.
  function closeToProfile() {
    panel.remove();
    profileWrap?.remove();
    if (profileModalState?.wrap === profileWrap) profileModalState = null;
  }

  panel.innerHTML = `
    <div class="modal-sheet">
      <button class="modal-close-x" id="week-picks-x-btn" aria-label="Close">&times;</button>
      <h3 style="text-align:center; margin-top:0;">${escapeHtml(uname)} -- Week ${weekNumber}</h3>
      <div class="hint" style="text-align:center;">Loading…</div>
    </div>
  `;
  panel.querySelector("#week-picks-x-btn").addEventListener("click", closeToProfile);

  try {
    let picksQuery = supabase.from("picks").select("*").eq("user_id", userId).eq("week_number", weekNumber);
    let gamesQuery = supabase.from("games").select("*").eq("week_number", weekNumber);
    if (seasonId != null) {
      picksQuery = picksQuery.eq("season_id", seasonId);
      gamesQuery = gamesQuery.eq("season_id", seasonId);
    }
    const [{ data: picks, error: pErr }, { data: games, error: gErr }] = await Promise.all([picksQuery, gamesQuery]);
    if (pErr) throw pErr;
    if (gErr) throw gErr;

    const gameLookup = Object.fromEntries((games || []).map((g) => [g.game_id, g]));
    const liveScores = await fetchLiveScores(games || []);
    const rows = (picks || []).slice().sort((a, b) => {
      const ga = gameLookup[a.game_id], gb = gameLookup[b.game_id];
      return (ga?.kickoff_time || "").localeCompare(gb?.kickoff_time || "");
    });

    panel.innerHTML = `
      <div class="modal-sheet">
        <button class="modal-close-x" id="week-picks-x-btn" aria-label="Close">&times;</button>
        <h3 style="text-align:center; margin-top:0;">${escapeHtml(uname)} -- Week ${weekNumber}</h3>
        ${rows.length ? rows.map((p) => {
          const g = gameLookup[p.game_id];
          const matchup = g ? `${g.favorite_team} vs ${g.underdog_team}` : p.game_id;
          const spread = p.spread_at_pick || g?.spread_value || "";
          const resultClass = p.result === "win" ? "win" : p.result === "loss" ? "loss" : "";
          const resultLabel = p.result === "win" ? "✓ Win" : p.result === "loss" ? "✗ Loss" : "Pending";
          return `
            <div class="game-card" style="margin-bottom:7px;">
              <div class="game-card-stripe ${resultClass}"></div>
              <div class="game-card-body">
                <div class="game-card-top game-card-clickable" data-open-gamecard="${escapeHtml(p.game_id)}">
                  <div class="game-card-matchup">${escapeHtml(matchup)}</div>
                  <div class="game-card-meta"><span class="spread">${escapeHtml(spread)}</span></div>
                </div>
                <div class="game-card-pickrow ${resultClass === "win" ? "win-bg" : ""}">
                  <span class="label">Picked</span>
                  <span class="value">${escapeHtml(p.selected_team)}</span>
                  <span class="value ${resultClass}">${resultLabel}</span>
                </div>
              </div>
            </div>
          `;
        }).join("") : `<div class="hint" style="text-align:center;">No picks on file for this week.</div>`}
        <button class="btn btn-secondary" id="week-picks-close-btn" style="margin-top:10px;">Close</button>
      </div>
    `;
    panel.querySelector("#week-picks-x-btn").addEventListener("click", closeToProfile);
    panel.querySelector("#week-picks-close-btn").addEventListener("click", () => panel.remove());
    panel.querySelectorAll("[data-open-gamecard]").forEach((headerEl) => {
      headerEl.addEventListener("click", () => {
        const gid = headerEl.dataset.openGamecard;
        const g = gameLookup[gid];
        if (g) openGameDetailModal(g, liveScores[gid]);
      });
    });
  } catch (e) {
    panel.innerHTML = `
      <div class="modal-sheet">
        <button class="modal-close-x" id="week-picks-x-btn" aria-label="Close">&times;</button>
        <h3 style="text-align:center; margin-top:0;">${escapeHtml(uname)} -- Week ${weekNumber}</h3>
        <div class="error-msg" style="text-align:center;">Couldn't load picks: ${escapeHtml(e.message || String(e))}</div>
        <button class="btn btn-secondary" id="week-picks-close-btn" style="margin-top:10px;">Close</button>
      </div>
    `;
    panel.querySelector("#week-picks-x-btn").addEventListener("click", closeToProfile);
    panel.querySelector("#week-picks-close-btn").addEventListener("click", () => panel.remove());
  }
}

async function openPlayerDmThread(otherId, otherUsername, avatarsByUsername) {
  if (profileDmState?.timer) clearInterval(profileDmState.timer);
  profileDmState?.wrap?.remove();
  markDmRead(otherId);
  profileDmState = { otherId, otherUsername, avatarsByUsername, messages: [], loading: true, error: null, wrap: null, timer: null };
  drawPlayerDmModal();
  await loadPlayerDm();
  if (profileDmState) profileDmState.timer = setInterval(loadPlayerDm, 4000);
}

function closePlayerDmThread() {
  if (profileDmState?.timer) clearInterval(profileDmState.timer);
  profileDmState?.wrap?.remove();
  profileDmState = null;
}

async function loadPlayerDm() {
  if (!profileDmState) return;
  const { otherId } = profileDmState;
  try {
    const { data, error } = await supabase.from("direct_messages").select("*")
      .or(`and(sender_id.eq.${state.user.id},recipient_id.eq.${otherId}),and(sender_id.eq.${otherId},recipient_id.eq.${state.user.id})`)
      .order("created_at", { ascending: true });
    if (error) throw error;
    if (!profileDmState) return;
    profileDmState.messages = data || [];
    profileDmState.loading = false;
    redrawPlayerDmModal();
  } catch (e) {
    if (!profileDmState) return;
    profileDmState.loading = false;
    profileDmState.error = e.message || "Couldn't load messages.";
    redrawPlayerDmModal();
  }
}

function playerDmMsgHtml(m) {
  const mine = m.sender_id === state.user.id;
  let timeStr = "";
  try {
    timeStr = new Date(m.created_at).toLocaleString("en-US", {
      month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
    });
  } catch (_) {}
  return `
    <div class="dm-msg ${mine ? "mine" : ""}">
      <div class="meta">${mine ? "You" : escapeHtml(profileDmState.otherUsername)} · ${escapeHtml(timeStr)}</div>
      <div class="bubble">${escapeHtml(m.message)}</div>
    </div>
  `;
}

function drawPlayerDmModal() {
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  profileDmState.wrap = wrap;
  renderPlayerDmInner(wrap);
  document.body.appendChild(wrap);
}

function renderPlayerDmInner(wrap) {
  const { otherUsername, messages, loading, error, avatarsByUsername } = profileDmState;
  wrap.innerHTML = `
    <div class="modal-sheet">
      <h2 style="display:flex; align-items:center; gap:8px;">
        <span class="avatar-circle-sm">${avatarInnerHtml(avatarsByUsername?.[otherUsername]?.url, avatarsByUsername?.[otherUsername]?.monogram, otherUsername)}</span>
        ${escapeHtml(otherUsername)}
      </h2>
      ${error ? `<div class="error-msg">${escapeHtml(error)}</div>` : ""}
      <div class="dm-list" id="dm-list">
        ${loading ? `<div class="centered" style="min-height:0; padding:20px 0;"><div class="loading-spinner"></div></div>` : (
          messages.length ? messages.map(playerDmMsgHtml).join("") : `<div class="hint" style="text-align:center;">No messages yet — say hi!</div>`
        )}
      </div>
      <div class="dm-input-row">
        <textarea id="dm-text-input" placeholder="Message ${escapeHtml(otherUsername)}…" rows="1"></textarea>
        <button class="btn btn-primary" id="dm-send-btn">Send</button>
      </div>
      <button class="btn btn-secondary" id="dm-close-btn" style="margin-top:10px;">Close</button>
    </div>
  `;
  const list = wrap.querySelector("#dm-list");
  if (list) list.scrollTop = list.scrollHeight + 1000;

  wrap.querySelector("#dm-close-btn").addEventListener("click", closePlayerDmThread);
  const sendBtn = wrap.querySelector("#dm-send-btn");
  const textInput = wrap.querySelector("#dm-text-input");
  const send = async () => {
    const text = (textInput.value || "").trim();
    if (!text || !profileDmState) return;
    sendBtn.disabled = true;
    try {
      const { error: insErr } = await supabase.from("direct_messages").insert({
        sender_id: state.user.id, recipient_id: profileDmState.otherId, message: text,
      });
      if (insErr) throw insErr;
      textInput.value = "";
      await loadPlayerDm();
    } catch (e) {
      profileDmState.error = "Couldn't send: " + (e.message || e);
      redrawPlayerDmModal();
    } finally {
      sendBtn.disabled = false;
    }
  };
  sendBtn.addEventListener("click", send);
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
}

function redrawPlayerDmModal() {
  if (profileDmState?.wrap) renderPlayerDmInner(profileDmState.wrap);
}

// Avatar circle (top bar) -> a bottom-sheet account menu, same modal pattern
// picks.js already uses for its own modals: appended straight to
// document.body (so renderChrome()'s root.innerHTML rewrites never touch
// it) with a local `redraw()` that patches just this sheet instead of
// going through the whole app's render().
// "My Leagues" bottom sheet -- switch leagues, or jump into creating/joining
// one. Same self-contained-panel pattern as the account menu / Start New
// Season below.
function openLeagueSwitcher() {
  if (document.querySelector(".modal-backdrop")) return;
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  document.body.appendChild(wrap);

  function redraw() {
    wrap.innerHTML = `
      <div class="modal-sheet">
        <div class="sheet-head" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
          <h3 style="margin:0;">My Leagues</h3>
          <button class="close" id="switcher-close-x" aria-label="Close">&times;</button>
        </div>
        ${state.userLeagues.map((l) => `
          <div class="league-row" data-league-id="${escapeHtml(l.id)}">
            <div>
              <div class="name">${escapeHtml(l.name)}</div>
              <div class="meta">${l.role === "admin" ? "Admin" : "Player"}</div>
            </div>
            ${state.currentLeague && String(state.currentLeague.id) === String(l.id) ? `<span class="check">✓</span>` : ""}
          </div>
        `).join("")}
        ${state.isSuperAdmin ? `<button class="btn btn-secondary" id="switcher-create-btn" style="margin-top:14px;">➕ Create a League</button>` : ""}
        <button class="btn btn-secondary" id="switcher-join-btn" style="margin-top:8px;">\u{1F511} Join a League</button>
      </div>
    `;
    wrap.querySelector("#switcher-close-x")?.addEventListener("click", () => wrap.remove());
    wrap.querySelectorAll(".league-row").forEach((row) => {
      row.addEventListener("click", async () => {
        await setCurrentLeague(row.dataset.leagueId);
        wrap.remove();
      });
    });
    wrap.querySelector("#switcher-create-btn")?.addEventListener("click", () => {
      wrap.remove();
      openCreateLeaguePanel();
    });
    wrap.querySelector("#switcher-join-btn")?.addEventListener("click", () => {
      wrap.remove();
      openJoinLeaguePanel();
    });
  }

  redraw();
}

// Join a league by invite code -- available from the switcher above, or
// (via renderJoinLeagueGate) to a brand new signup who isn't in one yet.
function openJoinLeaguePanel() {
  const panel = document.createElement("div");
  panel.className = "modal-backdrop";
  document.body.appendChild(panel);

  let saving = false;
  let msg = "";

  function panelRedraw() {
    panel.innerHTML = `
      <div class="modal-sheet">
        <h3 style="text-align:center; margin-top:0;">Join a League</h3>
        <div class="field">
          <label>Invite code</label>
          <input type="text" id="join-league-code" placeholder="ABCD1234" style="text-transform:uppercase; letter-spacing:0.08em; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
        </div>
        <div class="hint" style="min-height:1.2em; margin-bottom:10px;">${msg ? escapeHtml(msg) : "Ask the league's admin for their invite code."}</div>
        <div class="btn-row">
          <button class="btn btn-secondary" id="join-league-cancel-btn" ${saving ? "disabled" : ""}>Cancel</button>
          <button class="btn btn-primary" id="join-league-confirm-btn" ${saving ? "disabled" : ""}>${saving ? "Joining…" : "Join League"}</button>
        </div>
      </div>
    `;
    panel.querySelector("#join-league-cancel-btn")?.addEventListener("click", () => panel.remove());
    panel.querySelector("#join-league-confirm-btn")?.addEventListener("click", async () => {
      const code = (panel.querySelector("#join-league-code").value || "").trim();
      if (!code) { msg = "Enter an invite code."; panelRedraw(); return; }
      saving = true;
      msg = "";
      panelRedraw();
      try {
        await supabase.rpc("join_league_by_code", { p_code: code });
        await refreshLeagues();
        await refreshLeagueAdmin();
        await refreshCurrentSeason();
        panel.remove();
        render();
      } catch (err) {
        msg = "Couldn't join: " + (err.message || err);
        saving = false;
        panelRedraw();
      }
    });
  }

  panelRedraw();
}

// Create a league -- super-admin only (gated at the call site, the switcher
// above). Creates the league, then its first season in one flow, then shows
// the invite code with a "Send via Text" link, mirroring the Create League
// mockup Trent approved. Season-length can be set by week count or by an
// end date, which is converted to a week count client-side -- the DB only
// ever stores season_weeks, same as Start New Season below.
function openCreateLeaguePanel() {
  const panel = document.createElement("div");
  panel.className = "modal-backdrop";
  document.body.appendChild(panel);

  let saving = false;
  let msg = "";
  let created = null; // { name, invite_code }
  let pickCountMode = "exact";
  let lengthMode = "weeks";
  const thisYear = new Date().getFullYear();

  function panelRedraw() {
    if (created) {
      const inviteMessage =
        `Join my ${created.name} pick'em league! Download the app at ` +
        `https://sgafootballcentral.github.io/pick7-football-pool/ and enter invite code ${created.invite_code} to join.`;
      panel.innerHTML = `
        <div class="modal-sheet">
          <button class="modal-close-x" id="create-league-done-x" aria-label="Close">&times;</button>
          <h3 style="text-align:center; margin-top:0;">\u{1F389} League Created!</h3>
          <div style="font-weight:700; font-size:1.05rem; margin-bottom:2px;">${escapeHtml(created.name)}</div>
          <div class="hint" style="margin-bottom:6px;">Its first season is set up and ready -- share the code below so people can join themselves, or add them manually from Admin \u2192 Leagues.</div>
          <div class="code-box">
            <div class="code-row"><span class="code">${escapeHtml(created.invite_code)}</span></div>
            <div class="code-box-actions">
              <button class="copy-btn" id="create-league-copy-btn">\u{1F4CB} Copy Code</button>
              <a class="text-btn" href="sms:?body=${encodeURIComponent(inviteMessage)}">\u{1F4F1} Send via Text</a>
            </div>
          </div>
          <button class="btn btn-primary" id="create-league-done-btn" style="margin-top:16px;">Done</button>
        </div>
      `;
      panel.querySelector("#create-league-done-x")?.addEventListener("click", () => panel.remove());
      panel.querySelector("#create-league-done-btn")?.addEventListener("click", () => panel.remove());
      panel.querySelector("#create-league-copy-btn")?.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(created.invite_code); } catch (_) { /* non-critical */ }
      });
      return;
    }

    panel.innerHTML = `
      <div class="modal-sheet">
        <button class="modal-close-x" id="create-league-close-x" aria-label="Close">&times;</button>
        <h3 style="text-align:center; margin-top:0;">Create a League</h3>
        <div class="field">
          <label>League name</label>
          <input type="text" id="create-league-name" placeholder="e.g. Downtown Dynasty">
        </div>
        <div class="section-label">First Season</div>
        <div class="hint" style="margin-bottom:10px;">Every league starts with its own season -- set it up however this league plays.</div>
        <div class="field">
          <label>Year</label>
          <input type="number" id="create-league-year" value="${thisYear}">
        </div>
        <div class="field">
          <label>Picks per week</label>
          <div class="seg-toggle">
            <div class="seg-toggle-opt">
              <input type="radio" name="create-league-pick-mode" id="create-league-pick-exact" ${pickCountMode === "exact" ? "checked" : ""}>
              <label for="create-league-pick-exact">Exactly N games</label>
            </div>
            <div class="seg-toggle-opt">
              <input type="radio" name="create-league-pick-mode" id="create-league-pick-all" ${pickCountMode === "all" ? "checked" : ""}>
              <label for="create-league-pick-all">Every game</label>
            </div>
          </div>
          <div class="hint">Exactly <input type="number" id="create-league-pick-count" class="inline-num" value="7" min="1" ${pickCountMode === "exact" ? "" : "disabled"}> games each week -- or pick every game on the slate (e.g. a playoff round).</div>
        </div>
        <div class="field">
          <label>Sync games from</label>
          <div class="check-row"><input type="checkbox" id="create-league-nfl" checked><span>\u{1F3C8} NFL</span></div>
          <div class="check-row"><input type="checkbox" id="create-league-cfb" checked><span>\u{1F393} College Football</span></div>
        </div>
        <div class="field">
          <label>Season length</label>
          <div class="seg-toggle">
            <div class="seg-toggle-opt">
              <input type="radio" name="create-league-len-mode" id="create-league-len-weeks" ${lengthMode === "weeks" ? "checked" : ""}>
              <label for="create-league-len-weeks">By # of weeks</label>
            </div>
            <div class="seg-toggle-opt">
              <input type="radio" name="create-league-len-mode" id="create-league-len-date" ${lengthMode === "date" ? "checked" : ""}>
              <label for="create-league-len-date">By end date</label>
            </div>
          </div>
          ${lengthMode === "weeks" ? `
            <input type="number" id="create-league-weeks" value="16" min="1">
            <div class="hint">Number of weeks this season runs.</div>
          ` : `
            <input type="date" id="create-league-end-date">
            <div class="hint">We'll work out the number of weeks from today to this date.</div>
          `}
        </div>
        <div class="field">
          <label>Default pick-lock (optional)</label>
          <input type="number" id="create-league-lock-offset" placeholder="minutes before kickoff" min="0">
          <div class="hint">Leave blank to set lock times by hand each week.</div>
        </div>
        <div class="hint" style="min-height:1.2em; margin-bottom:10px;">${msg ? escapeHtml(msg) : ""}</div>
        <div class="btn-row">
          <button class="btn btn-secondary" id="create-league-cancel-btn" ${saving ? "disabled" : ""}>Cancel</button>
          <button class="btn btn-primary" id="create-league-confirm-btn" ${saving ? "disabled" : ""}>${saving ? "Creating…" : "Create League"}</button>
        </div>
      </div>
    `;

    panel.querySelector("#create-league-close-x")?.addEventListener("click", () => panel.remove());
    panel.querySelector("#create-league-pick-exact")?.addEventListener("change", () => { pickCountMode = "exact"; panelRedraw(); });
    panel.querySelector("#create-league-pick-all")?.addEventListener("change", () => { pickCountMode = "all"; panelRedraw(); });
    panel.querySelector("#create-league-len-weeks")?.addEventListener("change", () => { lengthMode = "weeks"; panelRedraw(); });
    panel.querySelector("#create-league-len-date")?.addEventListener("change", () => { lengthMode = "date"; panelRedraw(); });
    panel.querySelector("#create-league-cancel-btn")?.addEventListener("click", () => panel.remove());
    panel.querySelector("#create-league-confirm-btn")?.addEventListener("click", async () => {
      const name = (panel.querySelector("#create-league-name").value || "").trim();
      const year = parseInt(panel.querySelector("#create-league-year").value, 10);
      const pickCountExact = parseInt(panel.querySelector("#create-league-pick-count").value, 10);
      const lockOffsetRaw = (panel.querySelector("#create-league-lock-offset").value || "").trim();
      const lockOffset = lockOffsetRaw === "" ? null : parseInt(lockOffsetRaw, 10);
      const syncLeagues = [
        panel.querySelector("#create-league-nfl").checked ? "NFL" : null,
        panel.querySelector("#create-league-cfb").checked ? "CFB" : null,
      ].filter(Boolean);

      let seasonWeeks;
      if (lengthMode === "weeks") {
        seasonWeeks = parseInt(panel.querySelector("#create-league-weeks").value, 10);
      } else {
        const endDateRaw = panel.querySelector("#create-league-end-date").value;
        if (!endDateRaw) { msg = "Pick an end date."; panelRedraw(); return; }
        const endDate = new Date(endDateRaw + "T00:00:00");
        seasonWeeks = Math.max(1, Math.ceil((endDate - new Date()) / (7 * 86400000)));
      }

      if (!name) { msg = "Enter a league name."; panelRedraw(); return; }
      if (!year) { msg = "Enter a valid year."; panelRedraw(); return; }
      if (!seasonWeeks || seasonWeeks < 1) { msg = "Enter a valid season length."; panelRedraw(); return; }
      if (!syncLeagues.length) { msg = "Pick at least one league to sync games from."; panelRedraw(); return; }
      if (pickCountMode === "exact" && (!pickCountExact || pickCountExact < 1)) {
        msg = "Enter how many games each player picks (at least 1).";
        panelRedraw();
        return;
      }

      saving = true;
      msg = "";
      panelRedraw();
      try {
        const { data: newLeagueId } = await supabase.rpc("create_league", { p_name: name });
        await supabase.rpc("start_new_season", {
          p_league_id: newLeagueId,
          p_year: year,
          p_label: null,
          p_pick_count_mode: pickCountMode,
          p_pick_count_exact: pickCountMode === "exact" ? pickCountExact : 7,
          p_sync_leagues: syncLeagues,
          p_season_weeks: seasonWeeks,
          p_default_lock_offset_minutes: lockOffset,
        });
        await refreshLeagues();
        const newLeague = state.userLeagues.find((l) => String(l.id) === String(newLeagueId));
        if (newLeague) await setCurrentLeague(newLeague.id);
        created = { name, invite_code: newLeague ? newLeague.invite_code : "" };
        saving = false;
        panelRedraw();
      } catch (err) {
        msg = "Couldn't create league: " + (err.message || err);
        saving = false;
        panelRedraw();
      }
    });
  }

  panelRedraw();
}

async function openAccountMenu() {
  if (document.querySelector(".modal-backdrop")) return; // already open

  const menu = {
    nameDraft: state.username || "", nameSaving: false, nameMsg: "",
    photoUploading: false, photoMsg: "",
    showMonogramEditor: false, monogramDraft: state.avatarMonogram || "", monogramSaving: false, monogramMsg: "",
    resetSaving: false, resetMsg: "",
    notifMsg: "",
    seasonSaving: false, seasonMsg: "",
  };

  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  document.body.appendChild(wrap);

  function notifButtonInfo() {
    if (state.notifState === "unsupported") return null;
    if (state.notifState === "checking") return { label: "Checking notifications…", disabled: true };
    if (state.notifState === "denied") return { label: "\u{1F515} Notifications blocked -- enable in browser settings", disabled: true };
    const on = state.notifState === "subscribed";
    return { label: on ? "\u{1F514} Notifications on" : "\u{1F515} Enable notifications", disabled: false };
  }

  // Best-effort cleanup of whatever photo used to be in the "avatars"
  // bucket -- never blocks the action it's cleaning up after.
  async function removeStoredAvatar(url) {
    if (!url) return;
    const marker = "/avatars/";
    const idx = url.indexOf(marker);
    if (idx === -1) return;
    try { await supabase.storage.from("avatars").remove([url.slice(idx + marker.length)]); } catch (_) { /* non-critical */ }
  }

  async function uploadAvatarBlob(blob) {
    const path = `${state.user.id}/${crypto.randomUUID()}.jpg`;
    const { error: upErr } = await supabase.storage.from("avatars").upload(path, blob, { contentType: "image/jpeg" });
    if (upErr) throw upErr;
    const { data } = supabase.storage.from("avatars").getPublicUrl(path);
    const oldUrl = state.avatarUrl;
    await supabase.from("players").update({ avatar_url: data.publicUrl, avatar_monogram: null }).eq("id", state.user.id);
    state.avatarUrl = data.publicUrl;
    state.avatarMonogram = null;
    await removeStoredAvatar(oldUrl);
    render(); // refresh the top-bar avatar too
  }

  // Lets someone drag the photo around and zoom it in/out inside a circle
  // that's exactly what gets saved -- opened on top of the account menu
  // (its own stacked modal-backdrop) once a file is picked.
  // `source` is either a freshly-picked File (Change Photo) or the current
  // avatar's own URL as a string (Edit Photo, re-adjusting what's already
  // saved without re-uploading). Supabase's "avatars" bucket serves public
  // objects with permissive CORS, so loading the existing URL with
  // crossOrigin="anonymous" and drawing it to canvas works the same as a
  // freshly-picked file -- confirmed against production.
  function openCropper(source) {
    const isFile = source instanceof File;
    const imageSrc = isFile ? URL.createObjectURL(source) : source;
    const circleSize = 240;
    const minZoom = 1, maxZoom = 3;
    const crop = { zoom: minZoom, panX: 0, panY: 0, baseScale: 1, naturalW: 0, naturalH: 0 };

    const cropWrap = document.createElement("div");
    cropWrap.className = "modal-backdrop";
    document.body.appendChild(cropWrap);

    function closeCropper() {
      if (isFile) URL.revokeObjectURL(imageSrc);
      cropWrap.remove();
    }

    cropWrap.innerHTML = `
      <div class="modal-sheet">
        <h3 style="text-align:center; margin-top:0;">Adjust Photo</h3>
        <div class="cropper-circle" id="cropper-circle">
          <img id="cropper-img" alt="" style="display:none;">
        </div>
        <input type="range" id="cropper-zoom" min="${minZoom * 100}" max="${maxZoom * 100}" value="${minZoom * 100}" style="width:100%; margin:14px 0;">
        <div class="hint" id="cropper-msg" style="text-align:center; min-height:1.2em; margin-bottom:10px;"></div>
        <div class="btn-row">
          <button class="btn btn-secondary" id="cropper-cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="cropper-use-btn" disabled>Use Photo</button>
        </div>
      </div>
    `;

    const circleEl = cropWrap.querySelector("#cropper-circle");
    const imgEl = cropWrap.querySelector("#cropper-img");
    const zoomEl = cropWrap.querySelector("#cropper-zoom");
    const msgEl = cropWrap.querySelector("#cropper-msg");
    const useBtn = cropWrap.querySelector("#cropper-use-btn");

    function applyTransform() {
      const scale = crop.baseScale * crop.zoom;
      const displayW = crop.naturalW * scale;
      const displayH = crop.naturalH * scale;
      const maxPanX = Math.max(0, (displayW - circleSize) / 2);
      const maxPanY = Math.max(0, (displayH - circleSize) / 2);
      crop.panX = Math.min(maxPanX, Math.max(-maxPanX, crop.panX));
      crop.panY = Math.min(maxPanY, Math.max(-maxPanY, crop.panY));
      const left = circleSize / 2 - displayW / 2 + crop.panX;
      const top = circleSize / 2 - displayH / 2 + crop.panY;
      imgEl.style.width = `${displayW}px`;
      imgEl.style.height = `${displayH}px`;
      imgEl.style.left = `${left}px`;
      imgEl.style.top = `${top}px`;
    }

    imgEl.onload = () => {
      crop.naturalW = imgEl.naturalWidth;
      crop.naturalH = imgEl.naturalHeight;
      crop.baseScale = circleSize / Math.min(crop.naturalW, crop.naturalH);
      imgEl.style.display = "block";
      applyTransform();
      useBtn.disabled = false;
    };
    imgEl.onerror = () => {
      msgEl.textContent = "Couldn't load that image.";
      useBtn.disabled = true;
    };
    if (!isFile) imgEl.crossOrigin = "anonymous"; // must be set before src for a remote URL
    imgEl.src = imageSrc;

    // Drag to pan -- pointer events cover touch, mouse, and trackpad alike.
    let dragging = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;
    circleEl.addEventListener("pointerdown", (e) => {
      dragging = true;
      circleEl.classList.add("dragging");
      circleEl.setPointerCapture(e.pointerId);
      startX = e.clientX; startY = e.clientY;
      startPanX = crop.panX; startPanY = crop.panY;
    });
    circleEl.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      crop.panX = startPanX + (e.clientX - startX);
      crop.panY = startPanY + (e.clientY - startY);
      applyTransform();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((evt) => {
      circleEl.addEventListener(evt, () => { dragging = false; circleEl.classList.remove("dragging"); });
    });

    zoomEl.addEventListener("input", () => {
      crop.zoom = Number(zoomEl.value) / 100;
      applyTransform();
    });

    cropWrap.querySelector("#cropper-cancel-btn").addEventListener("click", closeCropper);

    useBtn.addEventListener("click", async () => {
      useBtn.disabled = true;
      useBtn.textContent = "Saving…";
      try {
        const OUT = 480;
        const drawScale = OUT / circleSize;
        const canvas = document.createElement("canvas");
        canvas.width = OUT;
        canvas.height = OUT;
        const ctx = canvas.getContext("2d");
        const scale = crop.baseScale * crop.zoom;
        const displayW = crop.naturalW * scale;
        const displayH = crop.naturalH * scale;
        const left = circleSize / 2 - displayW / 2 + crop.panX;
        const top = circleSize / 2 - displayH / 2 + crop.panY;
        ctx.drawImage(imgEl, left * drawScale, top * drawScale, displayW * drawScale, displayH * drawScale);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
        if (!blob) throw new Error("Couldn't process that image.");
        await uploadAvatarBlob(blob);
        closeCropper();
        menu.photoMsg = "";
        redraw();
      } catch (err) {
        msgEl.textContent = "Upload failed: " + (err.message || err);
        useBtn.disabled = false;
        useBtn.textContent = "Use Photo";
      }
    });
  }

  function redraw() {
    const notif = notifButtonInfo();
    const hasCustomAvatar = !!(state.avatarUrl || state.avatarMonogram);
    wrap.innerHTML = `
      <div class="modal-sheet">
        <div style="display:flex; justify-content:center; margin-bottom:16px;">
          <div class="avatar-circle-lg">${avatarInnerHtml(state.avatarUrl, state.avatarMonogram, state.username)}</div>
        </div>

        <div style="text-align:center; margin-bottom:12px;">
          <input type="file" id="account-avatar-input" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none;">
          <div class="btn-row">
            ${state.avatarUrl ? `<button class="btn btn-secondary" id="account-edit-photo-btn" ${menu.photoUploading ? "disabled" : ""}>Edit Photo</button>` : ""}
            <button class="btn btn-secondary" id="account-change-photo-btn" ${menu.photoUploading ? "disabled" : ""}>
              ${menu.photoUploading ? "Uploading…" : "Change Photo"}
            </button>
            <button class="btn btn-secondary" id="account-monogram-btn">Use Letters</button>
          </div>
          ${menu.photoMsg ? `<div class="hint" style="margin-top:6px;">${escapeHtml(menu.photoMsg)}</div>` : ""}
        </div>

        ${menu.showMonogramEditor ? `
          <div class="field">
            <label>Letters (up to 3, e.g. your initials)</label>
            <input type="text" id="account-monogram-input" maxlength="3" value="${escapeHtml(menu.monogramDraft)}" style="text-transform:uppercase;">
          </div>
          <div class="btn-row" style="margin-bottom:6px;">
            <button class="btn btn-secondary" id="account-monogram-cancel-btn">Cancel</button>
            <button class="btn btn-primary" id="account-monogram-save-btn" ${menu.monogramSaving ? "disabled" : ""}>
              ${menu.monogramSaving ? "Saving…" : "Save Letters"}
            </button>
          </div>
          <div class="hint" style="min-height:1.2em; margin-bottom:10px;">${menu.monogramMsg ? escapeHtml(menu.monogramMsg) : ""}</div>
        ` : ""}

        ${hasCustomAvatar ? `
          <button class="btn btn-secondary" id="account-reset-avatar-btn" style="margin-bottom:6px;" ${menu.resetSaving ? "disabled" : ""}>
            ${menu.resetSaving ? "Resetting…" : "Reset to Default"}
          </button>
          <div class="hint" style="min-height:1.2em; margin-bottom:10px;">${menu.resetMsg ? escapeHtml(menu.resetMsg) : ""}</div>
        ` : ""}

        <div class="field">
          <label>Display name</label>
          <input type="text" id="account-name-input" value="${escapeHtml(menu.nameDraft)}">
        </div>
        <button class="btn btn-primary" id="account-save-name-btn" style="margin-bottom:6px;" ${menu.nameSaving ? "disabled" : ""}>
          ${menu.nameSaving ? "Saving…" : "Save Name"}
        </button>
        <div class="hint" style="min-height:1.2em; margin-bottom:16px;">${menu.nameMsg ? escapeHtml(menu.nameMsg) : ""}</div>

        ${notif ? `
          <button class="btn btn-secondary" id="account-notif-btn" style="margin-bottom:6px;" ${notif.disabled ? "disabled" : ""}>${notif.label}</button>
          <div class="hint" style="min-height:1.2em; margin-bottom:10px;">${menu.notifMsg ? escapeHtml(menu.notifMsg) : ""}</div>
        ` : ""}

        ${state.currentSeason ? `
          <div class="field" style="margin-bottom:10px;">
            <label style="display:flex; align-items:center; justify-content:space-between; cursor:pointer; gap:10px;">
              <span>Playing in ${escapeHtml(state.currentSeason.label)}</span>
              <input type="checkbox" id="account-season-toggle" ${state.playerSeasonActive ? "checked" : ""} ${menu.seasonSaving ? "disabled" : ""}>
            </label>
          </div>
          <div class="hint" style="min-height:1.2em; margin-bottom:10px;">
            ${menu.seasonMsg ? escapeHtml(menu.seasonMsg) : "Turn this off if you don't want to play this season -- flip it back on any time, no need to sign up again."}
          </div>
        ` : ""}

        ${state.isAdmin && state.currentSeason ? `
          <button class="btn btn-secondary" id="account-manage-players-btn" style="margin-bottom:6px;">Manage Players (${escapeHtml(state.currentSeason.label)})</button>
        ` : ""}

        ${state.isAdmin ? `
          <button class="btn btn-secondary" id="account-start-season-btn" style="margin-bottom:10px;">Start New Season…</button>
        ` : ""}

        ${state.isAdmin ? `
          <button class="btn btn-secondary" id="account-edit-league-btn" style="margin-bottom:10px;">Edit League Settings…</button>
        ` : ""}

        ${state.isSuperAdmin ? `
          <button class="btn btn-secondary" id="account-delete-league-btn" style="margin-bottom:10px; color:var(--loss);">Delete League…</button>
        ` : ""}

        ${state.isAdmin ? `
          <a class="btn btn-secondary" href="${escapeHtml(buildAdminUrl())}" target="_blank" rel="noopener"
             style="text-decoration:none; margin-bottom:10px;">Admin ↗</a>
        ` : ""}

        <button class="btn btn-secondary" id="account-logout-btn" style="margin-bottom:10px;">Log Out</button>
        <button class="btn btn-secondary" id="account-done-btn">Done</button>
      </div>
    `;

    wrap.querySelector("#account-edit-photo-btn")?.addEventListener("click", () => {
      if (state.avatarUrl) openCropper(state.avatarUrl);
    });

    wrap.querySelector("#account-change-photo-btn")?.addEventListener("click", () => {
      wrap.querySelector("#account-avatar-input").click();
    });

    wrap.querySelector("#account-avatar-input")?.addEventListener("change", (e) => {
      const file = e.target.files[0];
      e.target.value = ""; // let the same file be re-picked later if they cancel out
      if (!file) return;
      openCropper(file);
    });

    wrap.querySelector("#account-monogram-btn")?.addEventListener("click", () => {
      menu.showMonogramEditor = true;
      menu.monogramDraft = state.avatarMonogram || "";
      menu.monogramMsg = "";
      redraw();
    });
    wrap.querySelector("#account-monogram-cancel-btn")?.addEventListener("click", () => {
      menu.showMonogramEditor = false;
      redraw();
    });
    wrap.querySelector("#account-monogram-save-btn")?.addEventListener("click", async () => {
      const letters = (wrap.querySelector("#account-monogram-input").value || "").trim().toUpperCase();
      if (!letters) {
        menu.monogramMsg = "Enter at least one letter.";
        redraw();
        return;
      }
      menu.monogramSaving = true;
      menu.monogramMsg = "";
      redraw();
      try {
        const oldUrl = state.avatarUrl;
        await supabase.from("players").update({ avatar_monogram: letters, avatar_url: null }).eq("id", state.user.id);
        state.avatarMonogram = letters;
        state.avatarUrl = null;
        await removeStoredAvatar(oldUrl);
        menu.showMonogramEditor = false;
        render(); // refresh the top-bar avatar too
      } catch (err) {
        menu.monogramMsg = "Couldn't save: " + (err.message || err);
      }
      menu.monogramSaving = false;
      redraw();
    });

    wrap.querySelector("#account-reset-avatar-btn")?.addEventListener("click", async () => {
      if (!confirm("Reset your avatar back to the default letter circle?")) return;
      menu.resetSaving = true;
      menu.resetMsg = "";
      redraw();
      try {
        const oldUrl = state.avatarUrl;
        await supabase.from("players").update({ avatar_url: null, avatar_monogram: null }).eq("id", state.user.id);
        state.avatarUrl = null;
        state.avatarMonogram = null;
        await removeStoredAvatar(oldUrl);
        render(); // refresh the top-bar avatar too
      } catch (err) {
        menu.resetMsg = "Couldn't reset: " + (err.message || err);
      }
      menu.resetSaving = false;
      redraw();
    });

    wrap.querySelector("#account-save-name-btn")?.addEventListener("click", async () => {
      const newName = (wrap.querySelector("#account-name-input").value || "").trim();
      if (!newName) {
        menu.nameMsg = "Display name can't be empty.";
        redraw();
        return;
      }
      if (newName === state.username) {
        menu.nameMsg = "That's already your display name.";
        redraw();
        return;
      }
      menu.nameSaving = true;
      menu.nameMsg = "";
      redraw();
      try {
        await supabase.from("players").update({ username: newName }).eq("id", state.user.id);
        // Keep past weeks' picks showing the current name, same as what
        // happens when an admin renames someone from the Player Roster.
        try { await supabase.from("picks").update({ username: newName }).eq("user_id", state.user.id); } catch (_) { /* non-critical */ }
        try { await supabase.from("pick_submissions").update({ username: newName }).eq("user_id", state.user.id); } catch (_) { /* non-critical */ }
        state.username = newName;
        menu.nameDraft = newName;
        menu.nameMsg = "Saved!";
        render(); // refresh the top-bar tooltip / anywhere else the name shows
      } catch (err) {
        menu.nameMsg = "Couldn't save: " + (err.message || err);
      }
      menu.nameSaving = false;
      redraw();
    });

    wrap.querySelector("#account-notif-btn")?.addEventListener("click", async () => {
      menu.notifMsg = "";
      try {
        if (state.notifState === "subscribed") {
          await unsubscribeFromPush(supabase);
          state.notifState = "unsubscribed";
        } else {
          await subscribeToPush(supabase, state.user.id);
          state.notifState = "subscribed";
        }
      } catch (e) {
        menu.notifMsg = e.message || "Couldn't update notification settings.";
        state.notifState = await getPushState();
      }
      redraw();
    });

    wrap.querySelector("#account-season-toggle")?.addEventListener("click", async (e) => {
      if (!state.currentSeason) return;
      const nextActive = e.target.checked;
      menu.seasonSaving = true;
      menu.seasonMsg = "";
      redraw();
      try {
        await supabase.from("player_seasons").upsert({
          season_id: state.currentSeason.id,
          user_id: state.user.id,
          active: nextActive,
        });
        state.playerSeasonActive = nextActive;
        menu.seasonMsg = nextActive ? "You're in!" : "You're sitting this season out.";
      } catch (err) {
        e.target.checked = !nextActive; // revert the checkbox on failure
        menu.seasonMsg = "Couldn't save: " + (err.message || err);
      }
      menu.seasonSaving = false;
      redraw();
    });

    wrap.querySelector("#account-manage-players-btn")?.addEventListener("click", () => {
      openManagePlayersPanel();
    });

    wrap.querySelector("#account-start-season-btn")?.addEventListener("click", () => {
      openStartSeasonPanel();
    });

    wrap.querySelector("#account-edit-league-btn")?.addEventListener("click", () => {
      openEditLeaguePanel();
    });

    wrap.querySelector("#account-delete-league-btn")?.addEventListener("click", () => {
      openDeleteLeaguePanel();
    });

    wrap.querySelector("#account-logout-btn")?.addEventListener("click", async () => {
      wrap.remove();
      await supabase.auth.signOut();
    });
    wrap.querySelector("#account-done-btn")?.addEventListener("click", () => {
      wrap.remove();
    });
  }

  // Admin-only: lists every player with a checkbox for whether they're
  // active in the current season -- the override half of the self-serve
  // toggle above. Opens as its own stacked modal, same pattern as the
  // photo cropper.
  async function openManagePlayersPanel() {
    if (!state.currentSeason || !state.currentLeague) return;
    const panel = document.createElement("div");
    panel.className = "modal-backdrop";
    document.body.appendChild(panel);

    let loading = true;
    let msg = "";
    let rows = [];

    function panelRedraw() {
      panel.innerHTML = `
        <div class="modal-sheet">
          <h3 style="text-align:center; margin-top:0;">Manage Players -- ${escapeHtml(state.currentSeason.label)}</h3>
          ${loading ? `<div class="hint" style="text-align:center;">Loading…</div>` : `
            <div style="max-height:50vh; overflow-y:auto; margin-bottom:12px;">
              ${rows.map((r) => `
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0; border-bottom:1px solid var(--border, #2a2a2a);">
                  <label style="display:flex; align-items:center; gap:10px; flex:1; min-width:0; cursor:pointer;">
                    <input type="checkbox" data-player-id="${escapeHtml(r.id)}" ${r.active ? "checked" : ""}>
                    <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(r.username || "(no name)")}</span>
                  </label>
                  ${state.isSuperAdmin ? `
                    <button class="btn btn-secondary" data-toggle-admin-id="${escapeHtml(r.id)}" style="width:auto; flex:none; padding:5px 10px; font-size:0.74rem;">
                      ${r.role === "admin" ? "Remove Admin" : "Make Admin"}
                    </button>
                  ` : ""}
                </div>
              `).join("") || `<div class="hint">No players yet.</div>`}
            </div>
          `}
          <div class="hint" style="min-height:1.2em; margin-bottom:10px;">${msg ? escapeHtml(msg) : ""}</div>
          <button class="btn btn-secondary" id="manage-players-close-btn">Close</button>
        </div>
      `;
      panel.querySelectorAll("input[data-player-id]").forEach((cb) => {
        cb.addEventListener("click", async (e) => {
          const playerId = e.target.dataset.playerId;
          const nextActive = e.target.checked;
          try {
            await supabase.from("player_seasons").upsert({
              season_id: state.currentSeason.id,
              user_id: playerId,
              active: nextActive,
            });
            const row = rows.find((r) => r.id === playerId);
            if (row) row.active = nextActive;
            if (playerId === state.user.id) state.playerSeasonActive = nextActive;
          } catch (err) {
            e.target.checked = !nextActive;
            msg = "Couldn't save: " + (err.message || err);
            panelRedraw();
          }
        });
      });
      panel.querySelectorAll("button[data-toggle-admin-id]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          const playerId = e.target.dataset.toggleAdminId;
          const row = rows.find((r) => r.id === playerId);
          if (!row) return;
          const nextRole = row.role === "admin" ? "player" : "admin";
          try {
            await supabase.from("league_members").update({ role: nextRole })
              .eq("league_id", state.currentLeague.id).eq("user_id", playerId);
            row.role = nextRole;
            panelRedraw();
          } catch (err) {
            msg = "Couldn't update admin status: " + (err.message || err);
            panelRedraw();
          }
        });
      });
      panel.querySelector("#manage-players-close-btn")?.addEventListener("click", () => panel.remove());
    }

    panelRedraw();

    try {
      const [{ data: memberRows }, { data: seasonRows }] = await Promise.all([
        supabase.from("league_members").select("role, players(id, username)").eq("league_id", state.currentLeague.id),
        supabase.from("player_seasons").select("user_id, active").eq("season_id", state.currentSeason.id),
      ]);
      const activeByUser = {};
      for (const r of seasonRows || []) activeByUser[r.user_id] = r.active;
      rows = (memberRows || [])
        .filter((m) => m.players)
        .map((m) => ({ id: m.players.id, username: m.players.username, role: m.role, active: activeByUser[m.players.id] !== false }))
        .sort((a, b) => (a.username || "").localeCompare(b.username || ""));
    } catch (err) {
      msg = "Couldn't load players: " + (err.message || err);
    }
    loading = false;
    panelRedraw();
  }

  // Any league admin: rename this league and edit its current season's
  // settings (picks per week, which sports it syncs from, default
  // pick-lock) via the update_league_settings RPC. Season length is the
  // one field gated to state.isSuperAdmin here, mirroring the RPC's own
  // server-side check -- a regular league admin's save never sends
  // p_season_weeks, so the super-admin check never even runs for them.
  // Opens as its own stacked modal, same pattern as Start New Season.
  function openEditLeaguePanel() {
    const season = state.currentSeason;
    const league = state.currentLeague;
    if (!season || !league) return;
    const panel = document.createElement("div");
    panel.className = "modal-backdrop";
    document.body.appendChild(panel);

    let saving = false;
    let msg = "";
    let pickCountMode = season.pick_count_mode === "all" ? "all" : "exact";

    function panelRedraw() {
      const syncLeagues = season.sync_leagues || ["NFL", "CFB"];
      panel.innerHTML = `
        <div class="modal-sheet">
          <h3 style="text-align:center; margin-top:0;">Edit League</h3>
          <div class="field">
            <label>League name</label>
            <input type="text" id="edit-league-name" value="${escapeHtml(league.name)}">
          </div>
          <div class="hint" style="margin: 2px 0 10px; text-transform:uppercase; letter-spacing:0.04em; font-weight:700; font-size:0.78rem;">Current Season</div>
          <div class="hint" style="margin-bottom:10px;">These apply to the season already in progress — changing them doesn't touch past weeks' games or picks.</div>
          <div class="field">
            <label>Picks per week</label>
            <div style="margin-bottom:8px;">
              <label style="font-weight:normal; display:block; margin-bottom:4px;">
                <input type="radio" name="edit-league-pick-mode" id="edit-league-pick-exact" value="exact" ${pickCountMode === "exact" ? "checked" : ""}>
                Exactly <input type="number" id="edit-league-pick-count" value="${season.pick_count_exact || 7}" min="1" style="width:60px; display:inline-block;" ${pickCountMode === "exact" ? "" : "disabled"}> games
              </label>
              <label style="font-weight:normal; display:block;">
                <input type="radio" name="edit-league-pick-mode" id="edit-league-pick-all" value="all" ${pickCountMode === "all" ? "checked" : ""}>
                Every game that week
              </label>
            </div>
          </div>
          <div class="field">
            <label>Sync games from</label>
            <div>
              <label style="font-weight:normal; margin-right:14px;"><input type="checkbox" id="edit-league-league-nfl" ${syncLeagues.includes("NFL") ? "checked" : ""}> NFL</label>
              <label style="font-weight:normal;"><input type="checkbox" id="edit-league-league-cfb" ${syncLeagues.includes("CFB") ? "checked" : ""}> CFB</label>
            </div>
          </div>
          <div class="field">
            <label>Default pick-lock (optional)</label>
            <input type="number" id="edit-league-lock-offset" min="0" value="${season.default_lock_offset_minutes ?? ''}" placeholder="minutes before kickoff">
            <div class="hint">Leave blank to set lock times by hand each week.</div>
          </div>
          <div class="hint" style="margin: 14px 0 7px; text-transform:uppercase; letter-spacing:0.04em; font-weight:700; font-size:0.78rem;">Season Length</div>
          ${state.isSuperAdmin ? `
            <div class="hint" style="margin-bottom:10px;">Changing this can add or remove weeks that may already have games or picks scheduled.</div>
            <div class="field">
              <input type="number" id="edit-league-season-weeks" value="${season.season_weeks || 16}" min="1">
            </div>
          ` : `
            <div class="hint" style="margin-bottom:10px;">🔒 Only the account's super admin can change this, since it can add or remove weeks that may already have games or picks scheduled.</div>
            <div class="field" style="opacity:0.45; pointer-events:none;">
              <input type="number" value="${season.season_weeks || 16}" disabled>
            </div>
          `}
          <div class="hint" style="min-height:1.2em; margin-bottom:10px;">${msg ? escapeHtml(msg) : ""}</div>
          <div class="btn-row">
            <button class="btn btn-secondary" id="edit-league-cancel-btn" ${saving ? "disabled" : ""}>Cancel</button>
            <button class="btn btn-primary" id="edit-league-save-btn" ${saving ? "disabled" : ""}>
              ${saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      `;
      panel.querySelector("#edit-league-pick-exact")?.addEventListener("change", () => { pickCountMode = "exact"; panelRedraw(); });
      panel.querySelector("#edit-league-pick-all")?.addEventListener("change", () => { pickCountMode = "all"; panelRedraw(); });
      panel.querySelector("#edit-league-cancel-btn")?.addEventListener("click", () => panel.remove());
      panel.querySelector("#edit-league-save-btn")?.addEventListener("click", async () => {
        const name = (panel.querySelector("#edit-league-name").value || "").trim();
        const pickCountExact = parseInt(panel.querySelector("#edit-league-pick-count").value, 10);
        const lockOffsetRaw = (panel.querySelector("#edit-league-lock-offset").value || "").trim();
        const lockOffset = lockOffsetRaw === "" ? null : parseInt(lockOffsetRaw, 10);
        const syncLeaguesNew = [
          panel.querySelector("#edit-league-league-nfl").checked ? "NFL" : null,
          panel.querySelector("#edit-league-league-cfb").checked ? "CFB" : null,
        ].filter(Boolean);
        const seasonWeeksInput = panel.querySelector("#edit-league-season-weeks");
        const seasonWeeks = state.isSuperAdmin && seasonWeeksInput ? parseInt(seasonWeeksInput.value, 10) : null;

        if (!name) {
          msg = "League name cannot be blank.";
          panelRedraw();
          return;
        }
        if (!syncLeaguesNew.length) {
          msg = "Pick at least one league to sync games from.";
          panelRedraw();
          return;
        }
        if (pickCountMode === "exact" && (!pickCountExact || pickCountExact < 1)) {
          msg = "Enter how many games each player picks (at least 1).";
          panelRedraw();
          return;
        }
        if (state.isSuperAdmin && (!seasonWeeks || seasonWeeks < 1)) {
          msg = "Enter a valid season length.";
          panelRedraw();
          return;
        }
        saving = true;
        msg = "";
        panelRedraw();
        try {
          await supabase.rpc("update_league_settings", {
            p_league_id: league.id,
            p_name: name,
            p_pick_count_mode: pickCountMode,
            p_pick_count_exact: pickCountMode === "exact" ? pickCountExact : 7,
            p_sync_leagues: syncLeaguesNew,
            p_default_lock_offset_minutes: lockOffset,
            p_season_weeks: seasonWeeks,
          });
          await refreshLeagues();
          await refreshCurrentSeason();
          panel.remove();
          redraw();
        } catch (err) {
          msg = "Couldn't save: " + (err.message || err);
          saving = false;
          panelRedraw();
        }
      });
    }

    panelRedraw();
  }

  // Super-admin only: permanently deletes the current league. Two
  // client-side confirmation layers -- an explanation of exactly what's
  // about to be destroyed, then a one-time code that must be typed back
  // exactly -- sit in front of the delete_league RPC, which only
  // re-checks WHO is calling server-side, not how they got here. Opens
  // as its own stacked modal, same pattern as the other admin panels.
  function openDeleteLeaguePanel() {
    const league = state.currentLeague;
    if (!league || !state.isSuperAdmin) return;
    const panel = document.createElement("div");
    panel.className = "modal-backdrop";
    document.body.appendChild(panel);

    let step = "explain";
    let code = "";
    let counts = null;
    let loading = true;
    let msg = "";

    async function loadCounts() {
      try {
        const memberRows = (await supabase.from("league_members").select("user_id").eq("league_id", league.id)).data || [];
        const seasonRows = (await supabase.from("seasons").select("id").eq("league_id", league.id)).data || [];
        const seasonIds = seasonRows.map((s) => s.id);
        let gamesCount = 0;
        let picksCount = 0;
        if (seasonIds.length) {
          gamesCount = ((await supabase.from("games").select("id").in("season_id", seasonIds)).data || []).length;
          picksCount = ((await supabase.from("picks").select("id").in("season_id", seasonIds)).data || []).length;
        }
        const chatRows = (await supabase.from("chat_messages").select("id").eq("league_id", league.id)).data || [];
        counts = {
          members: memberRows.length,
          seasons: seasonIds.length,
          games: gamesCount,
          picks: picksCount,
          chat: chatRows.length,
        };
      } catch (err) {
        counts = { members: "?", seasons: "?", games: "?", picks: "?", chat: "?" };
      }
      loading = false;
      panelRedraw();
    }

    function panelRedraw() {
      if (step === "explain") {
        panel.innerHTML = `
          <div class="modal-sheet">
            <h3 style="text-align:center; margin-top:0;">⚠️ Delete League</h3>
            ${loading ? `
              <div class="hint" style="text-align:center; margin-bottom:14px;">Checking what's in this league…</div>
            ` : `
              <div class="hint" style="margin-bottom:10px; color:var(--text);">
                This will permanently delete <b>${escapeHtml(league.name)}</b> -- its
                <b>${counts.members} member(s)</b>, <b>${counts.seasons} season(s)</b>,
                <b>${counts.games} game(s)</b>, <b>${counts.picks} pick(s)</b>, and
                <b>${counts.chat} chat message(s)</b>.
              </div>
              <div class="hint" style="margin-bottom:16px;">Everyone in this league will lose access to it immediately. This cannot be undone.</div>
            `}
            <div class="btn-row">
              <button class="btn btn-secondary" id="delete-league-cancel-btn">Cancel</button>
              <button class="btn btn-primary" id="delete-league-continue-btn" style="background:var(--loss); border-color:var(--loss);" ${loading ? "disabled" : ""}>I Understand, Continue</button>
            </div>
          </div>
        `;
        panel.querySelector("#delete-league-cancel-btn")?.addEventListener("click", () => panel.remove());
        panel.querySelector("#delete-league-continue-btn")?.addEventListener("click", () => {
          code = Math.random().toString(36).slice(2, 8).toUpperCase();
          step = "code";
          panelRedraw();
        });
      } else {
        panel.innerHTML = `
          <div class="modal-sheet">
            <h3 style="text-align:center; margin-top:0;">⚠️ Confirm Deletion</h3>
            <div class="hint" style="margin-bottom:8px;">As a second layer of protection, type this code exactly to confirm:</div>
            <div class="code-box">
              <div class="code-row"><span class="code">${code}</span></div>
            </div>
            <div class="field" style="margin-top:14px;">
              <label>Confirmation code</label>
              <input type="text" id="delete-league-code-input" placeholder="Type the code above" style="text-transform:uppercase; letter-spacing:0.08em; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
            </div>
            <div class="hint" style="min-height:1.2em; margin-bottom:10px;">${msg ? escapeHtml(msg) : `Deleting ${escapeHtml(league.name)} -- this is the last step and cannot be undone.`}</div>
            <div class="btn-row">
              <button class="btn btn-secondary" id="delete-league-code-cancel-btn">Cancel</button>
              <button class="btn btn-primary" id="delete-league-confirm-btn" style="background:var(--loss); border-color:var(--loss);" disabled>Permanently Delete League</button>
            </div>
          </div>
        `;
        panel.querySelector("#delete-league-code-cancel-btn")?.addEventListener("click", () => panel.remove());
        const codeInput = panel.querySelector("#delete-league-code-input");
        const confirmBtn = panel.querySelector("#delete-league-confirm-btn");
        codeInput?.addEventListener("input", () => {
          const isMatch = (codeInput.value || "").trim().toUpperCase() === code;
          if (confirmBtn) confirmBtn.disabled = !isMatch;
        });
        confirmBtn?.addEventListener("click", async () => {
          if ((codeInput.value || "").trim().toUpperCase() !== code) return;
          confirmBtn.disabled = true;
          confirmBtn.textContent = "Deleting…";
          try {
            await supabase.rpc("delete_league", { p_league_id: league.id });
            panel.remove();
            await refreshLeagues();
            await refreshCurrentSeason();
            render();
          } catch (err) {
            msg = "Couldn't delete: " + (err.message || err);
            confirmBtn.disabled = false;
            confirmBtn.textContent = "Permanently Delete League";
            panelRedraw();
          }
        });
      }
    }

    panelRedraw();
    loadCounts();
  }

  // Admin-only: rolls the league over to a new year via the start_new_season
  // RPC, which flips is_current and carries forward anyone active in the
  // outgoing season. Opens as its own stacked modal.
  function openStartSeasonPanel() {
    const nextYear = (state.currentSeason?.year || new Date().getFullYear()) + 1;
    const panel = document.createElement("div");
    panel.className = "modal-backdrop";
    document.body.appendChild(panel);

    let saving = false;
    let msg = "";

    // Defaults mirror today's hardcoded behavior exactly, so leaving every
    // field alone reproduces the current season's rules -- only change what
    // the new season should actually do differently (e.g. the CFB Playoffs:
    // "every game", CFB only, a short season).
    let pickCountMode = "exact";

    function panelRedraw() {
      panel.innerHTML = `
        <div class="modal-sheet">
          <h3 style="text-align:center; margin-top:0;">Start New Season</h3>
          <div class="hint" style="margin-bottom:14px;">
            This closes out ${state.currentSeason ? escapeHtml(state.currentSeason.label) : "the current season"} and opens a new one.
            Everyone currently playing carries over automatically -- nobody has to sign up again.
          </div>
          <div class="field">
            <label>Year</label>
            <input type="number" id="start-season-year" value="${nextYear}">
          </div>
          <div class="field">
            <label>Label (optional)</label>
            <input type="text" id="start-season-label" placeholder="${nextYear} Season">
          </div>
          <div class="field">
            <label>Season length (weeks)</label>
            <input type="number" id="start-season-weeks" value="16" min="1">
          </div>
          <div class="field">
            <label>Sync games from</label>
            <div>
              <label style="font-weight:normal; margin-right:14px;"><input type="checkbox" id="start-season-league-nfl" checked> NFL</label>
              <label style="font-weight:normal;"><input type="checkbox" id="start-season-league-cfb" checked> CFB</label>
            </div>
          </div>
          <div class="field">
            <label>How many games does everyone pick each week?</label>
            <div style="margin-bottom:8px;">
              <label style="font-weight:normal; display:block; margin-bottom:4px;">
                <input type="radio" name="start-season-pick-mode" id="start-season-pick-exact" value="exact" ${pickCountMode === "exact" ? "checked" : ""}>
                Exactly <input type="number" id="start-season-pick-count" value="7" min="1" style="width:60px; display:inline-block;" ${pickCountMode === "exact" ? "" : "disabled"}> games
              </label>
              <label style="font-weight:normal; display:block;">
                <input type="radio" name="start-season-pick-mode" id="start-season-pick-all" value="all" ${pickCountMode === "all" ? "checked" : ""}>
                Every game that week (good for single-elimination playoffs)
              </label>
            </div>
          </div>
          <div class="field">
            <label>Auto-lock picks before kickoff (optional)</label>
            <input type="number" id="start-season-lock-offset" placeholder="minutes before the week's first kickoff" min="0">
            <div class="hint">Leave blank to keep setting each week's lock time by hand, like today.</div>
          </div>
          <div class="hint" style="min-height:1.2em; margin-bottom:10px;">${msg ? escapeHtml(msg) : ""}</div>
          <div class="btn-row">
            <button class="btn btn-secondary" id="start-season-cancel-btn" ${saving ? "disabled" : ""}>Cancel</button>
            <button class="btn btn-primary" id="start-season-confirm-btn" ${saving ? "disabled" : ""}>
              ${saving ? "Starting…" : "Start Season"}
            </button>
          </div>
        </div>
      `;
      panel.querySelector("#start-season-pick-exact")?.addEventListener("change", () => { pickCountMode = "exact"; panelRedraw(); });
      panel.querySelector("#start-season-pick-all")?.addEventListener("change", () => { pickCountMode = "all"; panelRedraw(); });
      panel.querySelector("#start-season-cancel-btn")?.addEventListener("click", () => panel.remove());
      panel.querySelector("#start-season-confirm-btn")?.addEventListener("click", async () => {
        const year = parseInt(panel.querySelector("#start-season-year").value, 10);
        const label = (panel.querySelector("#start-season-label").value || "").trim();
        const seasonWeeks = parseInt(panel.querySelector("#start-season-weeks").value, 10);
        const pickCountExact = parseInt(panel.querySelector("#start-season-pick-count").value, 10);
        const lockOffsetRaw = (panel.querySelector("#start-season-lock-offset").value || "").trim();
        const lockOffset = lockOffsetRaw === "" ? null : parseInt(lockOffsetRaw, 10);
        const syncLeagues = [
          panel.querySelector("#start-season-league-nfl").checked ? "NFL" : null,
          panel.querySelector("#start-season-league-cfb").checked ? "CFB" : null,
        ].filter(Boolean);

        if (!year) {
          msg = "Enter a valid year.";
          panelRedraw();
          return;
        }
        if (!seasonWeeks || seasonWeeks < 1) {
          msg = "Enter a valid season length (at least 1 week).";
          panelRedraw();
          return;
        }
        if (!syncLeagues.length) {
          msg = "Pick at least one league to sync games from.";
          panelRedraw();
          return;
        }
        if (pickCountMode === "exact" && (!pickCountExact || pickCountExact < 1)) {
          msg = "Enter how many games each player picks (at least 1).";
          panelRedraw();
          return;
        }
        if (!confirm(`Start the ${label || year + " Season"} season now? This can't be easily undone.`)) return;
        saving = true;
        msg = "";
        panelRedraw();
        try {
          await supabase.rpc("start_new_season", {
            p_league_id: state.currentLeague.id,
            p_year: year,
            p_label: label || null,
            p_pick_count_mode: pickCountMode,
            p_pick_count_exact: pickCountMode === "exact" ? pickCountExact : 7,
            p_sync_leagues: syncLeagues,
            p_season_weeks: seasonWeeks,
            p_default_lock_offset_minutes: lockOffset,
          });
          await refreshCurrentSeason();
          panel.remove();
          redraw();
        } catch (err) {
          msg = "Couldn't start season: " + (err.message || err);
          saving = false;
          panelRedraw();
        }
      });
    }

    panelRedraw();
  }

  redraw();
  // Re-check fresh every time the menu opens -- the browser-level
  // notification permission can change outside the app at any point.
  state.notifState = pushSupported() ? await getPushState() : "unsupported";
  redraw();
}

export function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderJoinLeagueGate(el) {
  el.innerHTML = `
    <div class="card" style="margin:16px 14px;">
      <h3 style="margin-top:0;">Join a League</h3>
      <div class="hint" style="margin-bottom:12px;">You're not part of a league yet. Ask your league's admin for an invite code to join.</div>
      <div class="field">
        <label>Invite code</label>
        <input type="text" id="gate-join-code" placeholder="ABCD1234" style="text-transform:uppercase; letter-spacing:0.08em; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">
      </div>
      <div class="hint" id="gate-join-msg" style="min-height:1.2em; margin-bottom:10px;"></div>
      <button class="btn btn-primary" id="gate-join-btn">Join League</button>
    </div>
  `;
  el.querySelector("#gate-join-btn")?.addEventListener("click", async () => {
    const code = (el.querySelector("#gate-join-code").value || "").trim();
    const msgEl = el.querySelector("#gate-join-msg");
    if (!code) { msgEl.textContent = "Enter an invite code."; return; }
    try {
      await supabase.rpc("join_league_by_code", { p_code: code });
      await refreshLeagues();
      await refreshLeagueAdmin();
      await refreshCurrentSeason();
      render();
    } catch (err) {
      msgEl.textContent = "Couldn't join: " + (err.message || err);
    }
  });
}

export function render() {
  if (state.recoveryMode) {
    renderChrome(`<div id="tab-slot"></div>`);
    renderSetNewPassword(document.getElementById("tab-slot"), {
      supabase,
      onDone: () => {
        state.recoveryMode = false;
        window.history.replaceState(null, "", window.location.pathname);
        refreshIdentity().then(render);
      },
    });
    return;
  }

  if (!state.user) {
    renderChrome(`<div id="tab-slot"></div>`);
    renderAuth(document.getElementById("tab-slot"), { supabase });
    return;
  }

  if (!state.currentLeague) {
    renderChrome(`<div id="tab-slot"></div>`);
    renderJoinLeagueGate(document.getElementById("tab-slot"));
    return;
  }

  renderChrome(`<div id="tab-slot"></div>`);
  const slot = document.getElementById("tab-slot");
  const ctx = { supabase, user: state.user, username: state.username, isAdmin: state.isAdmin, unreadDmSenders: state.unreadDmSenders, markDmRead, currentSeason: state.currentSeason, currentLeague: state.currentLeague };

  if (state.activeTab === "picks") renderPicks(slot, ctx);
  else if (state.activeTab === "leaderboard") renderLeaderboard(slot, ctx);
  else if (state.activeTab === "compare") renderCompare(slot, ctx);
  else if (state.activeTab === "chat") renderChat(slot, ctx);
  else if (state.activeTab === "requests") renderRequestsVotes(slot, ctx);
}

// Ask the browser to treat this origin's storage (localStorage, where the
// Supabase session lives) as "persistent" rather than eligible for
// automatic eviction under storage pressure. Installed home-screen PWAs on
// iOS are already exempt from Safari's 7-day inactive-storage eviction, but
// this is a harmless, standard defensive request for everyone else (a
// regular browser tab, Android, desktop) -- no-op if unsupported, and never
// blocks anything if the browser silently ignores or auto-denies it.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

(async function boot() {
  await refreshIdentity();
  render();
  checkUnreadChat();
  checkUnreadDm();
  checkWeekRecap();
  setInterval(checkUnreadChat, 20000);
  setInterval(checkUnreadDm, 20000);
})();
