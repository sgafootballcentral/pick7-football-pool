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
  notifState: "checking",
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
    state.avatarUrl = null;
    state.avatarMonogram = null;
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
        <button class="avatar-btn" id="account-menu-btn" aria-label="Account menu" title="${escapeHtml(state.username || "")}">
          ${avatarInnerHtml(state.avatarUrl, state.avatarMonogram, state.username)}
        </button>
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
  document.getElementById("account-menu-btn")?.addEventListener("click", openAccountMenu);
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

// Avatar circle (top bar) -> a bottom-sheet account menu, same modal pattern
// picks.js already uses for its own modals: appended straight to
// document.body (so renderChrome()'s root.innerHTML rewrites never touch
// it) with a local `redraw()` that patches just this sheet instead of
// going through the whole app's render().
async function openAccountMenu() {
  if (document.querySelector(".modal-backdrop")) return; // already open

  const menu = {
    nameDraft: state.username || "", nameSaving: false, nameMsg: "",
    photoUploading: false, photoMsg: "",
    showMonogramEditor: false, monogramDraft: state.avatarMonogram || "", monogramSaving: false, monogramMsg: "",
    resetSaving: false, resetMsg: "",
    notifMsg: "",
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
  function openCropper(file) {
    const objectUrl = URL.createObjectURL(file);
    const circleSize = 240;
    const minZoom = 1, maxZoom = 3;
    const crop = { zoom: minZoom, panX: 0, panY: 0, baseScale: 1, naturalW: 0, naturalH: 0 };

    const cropWrap = document.createElement("div");
    cropWrap.className = "modal-backdrop";
    document.body.appendChild(cropWrap);

    function closeCropper() {
      URL.revokeObjectURL(objectUrl);
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
    imgEl.src = objectUrl;

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

        ${state.isAdmin ? `
          <a class="btn btn-secondary" href="${escapeHtml(buildAdminUrl())}" target="_blank" rel="noopener"
             style="text-decoration:none; margin-bottom:10px;">Admin ↗</a>
        ` : ""}

        <button class="btn btn-secondary" id="account-logout-btn" style="margin-bottom:10px;">Log Out</button>
        <button class="btn btn-secondary" id="account-done-btn">Done</button>
      </div>
    `;

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

    wrap.querySelector("#account-logout-btn")?.addEventListener("click", async () => {
      wrap.remove();
      await supabase.auth.signOut();
    });
    wrap.querySelector("#account-done-btn")?.addEventListener("click", () => {
      wrap.remove();
    });
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
