import { supabase } from "./supabaseClient.js";
import { renderAuth } from "./auth.js";
import { renderPicks } from "./picks.js";
import { renderLeaderboard } from "./leaderboard.js";
import { renderChat } from "./chat.js";
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

  state.username = state.user.user_metadata?.username || state.user.email;

  // Mirror the Streamlit app's own behavior: upsert a players row on login,
  // non-critical if it fails.
  try {
    await supabase.from("players").upsert({ id: state.user.id, username: state.username });
  } catch (_) { /* non-critical */ }

  try {
    const { data } = await supabase.from("league_users").select("role").eq("id", state.user.id).single();
    state.isAdmin = data?.role === "admin";
  } catch (_) {
    state.isAdmin = false;
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
    refreshIdentity().then(render);
  } else if (!state.user) {
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
        <button data-tab="chat" class="${state.activeTab === "chat" ? "active" : ""}">
          <span class="icon">\u{1F4AC}</span>Chat
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
  else if (state.activeTab === "chat") renderChat(slot, ctx);
}

(async function boot() {
  await refreshIdentity();
  render();
})();
