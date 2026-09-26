import { supabase } from "./supabaseClient.js";
import { renderAuth } from "./auth.js";
import { renderPicks } from "./picks.js";
import { renderLeaderboard } from "./leaderboard.js";
import { renderCompare } from "./compare.js";
import { renderChat } from "./chat.js";
import { renderRequestsVotes } from "./requestsVotes.js";
import { renderSetNewPassword } from "./recovery.js";

const root = document.getElementById("app");

const state = {
  session: null,
  user: null,
  username: null,
  isAdmin: false,
  activeTab: "picks",
  deferredInstallPrompt: null,
  installBannerDismissed: sessionStorage.getItem("installBannerDismissed") === "1",
  recoveryMode: false,
  lastChatReadAt: null,
  hasUnreadChat: false,
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
    state.isAdmin = false;
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
    const { data: existingPlayerRows } = await supabase.from("players").select("username, full_name").eq("id", state.user.id);
    if (existingPlayerRows && existingPlayerRows.length) {
      state.username = existingPlayerRows[0].username || signupUsername;
      if (!existingPlayerRows[0].full_name && signupFullName) {
        try {
          await supabase.from("players").update({ full_name: signupFullName }).eq("id", state.user.id);
        } catch (_) { /* non-critical */ }
      }
    } else {
      state.username = signupUsername;
      await supabase.from("players").insert({ id: state.user.id, username: state.username, full_name: signupFullName || null });
    }
  } catch (_) {
    state.username = signupUsername; // non-critical -- don't block the session over this
  }

  try {
    const { data } = await supabase.from("league_users").select("role").eq("id", state.user.id).single();
    state.isAdmin = data?.role === "admin";
  } catch (_) {
    state.isAdmin = false;
  }

  try {
    const { data } = await supabase.from("players").select("last_chat_read_at").eq("id", state.user.id).single();
    state.lastChatReadAt = data?.last_chat_read_at || null;
  } catch (_) {
    state.lastChatReadAt = null;
  }
}

// Lightweight poll for new chat activity -- independent of whether the Chat
// tab is mounted, so the bottom-nav badge stays accurate no matter which
// tab a player is looking at. Never counts a player's own messages as
// "unread", and never flags unread while the Chat tab is already open.
async function checkUnreadChat() {
  if (!state.user) return;
  try {
    const { data } = await supabase
      .from("chat_messages")
      .select("created_at,user_id")
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
  if (!state.user) return;
  state.hasUnreadChat = false;
  const nowIso = new Date().toISOString();
  state.lastChatReadAt = nowIso;
  try {
    await supabase.from("players").update({ last_chat_read_at: nowIso }).eq("id", state.user.id);
  } catch (_) {
    /* non-critical */
  }
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
    refreshIdentity().then(() => { render(); checkUnreadChat(); });
  } else if (!state.user) {
    state.hasUnreadChat = false;
    state.lastChatReadAt = null;
    state.username = null;
    state.isAdmin = false;
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
        <div class="who">Logged in as <b>${escapeHtml(state.username)}</b></div>
        <span style="display:flex; gap:6px; align-items:center;">
          ${state.isAdmin ? `
            <a class="btn btn-secondary" href="${escapeHtml(buildAdminUrl())}" target="_blank" rel="noopener"
               style="width:auto; padding:6px 12px; font-size:0.82rem; text-decoration:none;">Admin ↗</a>
          ` : ""}
          <button class="btn btn-secondary" id="logout-btn" style="width:auto; padding:6px 12px; font-size:0.82rem;">Log Out</button>
        </span>
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
  document.getElementById("logout-btn")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
  });
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

export function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  renderChrome(`<div id="tab-slot"></div>`);
  const slot = document.getElementById("tab-slot");
  const ctx = { supabase, user: state.user, username: state.username, isAdmin: state.isAdmin };

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
  setInterval(checkUnreadChat, 20000);
})();
