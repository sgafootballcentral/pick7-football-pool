import { escapeHtml } from "./app.js";
import { pushSupported, getPushState, subscribeToPush, unsubscribeFromPush } from "./push.js";

function storagePathFromUrl(url) {
  if (!url) return null;
  const marker = "/chat-images/";
  const idx = url.indexOf(marker);
  return idx === -1 ? null : url.slice(idx + marker.length);
}

export function renderChat(el, { supabase, user, username, isAdmin }) {
  const s = { loading: true, error: "", messages: [], autoRefresh: true, intervalSec: 5, pendingFile: null, notifState: "checking" };
  let timer = null;

  function scrollToBottom() {
    const list = el.querySelector("#chat-list");
    if (list) list.scrollTop = list.scrollHeight;
  }

  function draw(preserveScroll) {
    if (s.loading) {
      el.innerHTML = `<div class="centered"><div class="loading-spinner"></div></div>`;
      return;
    }

    el.innerHTML = `
      <h2>\u{1F4AC} League Chat</h2>
      <p class="hint">Messages stay here for everyone to see${isAdmin ? "" : " until an admin removes them"}.</p>
      <div class="btn-row" style="margin-bottom:10px;">
        <button class="btn btn-secondary" id="chat-refresh-btn" style="width:auto; padding:8px 12px;">\u{1F504} Refresh</button>
        <label class="hint" style="display:flex; align-items:center; gap:6px;">
          <input type="checkbox" id="chat-auto-toggle" ${s.autoRefresh ? "checked" : ""}> Auto-refresh (5s)
        </label>
        ${notifButtonHtml()}
        ${isAdmin ? `<button class="btn btn-secondary" id="chat-clear-btn" style="width:auto; padding:8px 12px; margin-left:auto;">\u{1F5D1}️ Clear All</button>` : ""}
      </div>
      ${s.error ? `<div class="error-msg">${escapeHtml(s.error)}</div>` : ""}
      <div class="chat-list" id="chat-list" style="max-height:55vh; overflow-y:auto;">
        ${s.messages.length ? s.messages.map((m) => chatMsgHtml(m)).join("") : `<div class="hint">No messages yet -- be the first to say something.</div>`}
      </div>
      <div class="chat-input-row">
        <input type="file" id="chat-file-input" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none;">
        <button class="btn btn-secondary" id="chat-attach-btn" style="width:auto; padding:11px 12px;">\u{1F4CE}</button>
        <input type="text" id="chat-text-input" placeholder="Type a message…">
        <button class="btn btn-primary" id="chat-send-btn">Send</button>
      </div>
      ${s.pendingFile ? `<div class="hint" style="margin-top:4px;">Attached: ${escapeHtml(s.pendingFile.name)} <button class="chat-delete" id="chat-remove-file">remove</button></div>` : ""}
    `;

    el.querySelector("#chat-refresh-btn").addEventListener("click", () => loadMessages(true));
    el.querySelector("#chat-auto-toggle").addEventListener("change", (e) => {
      s.autoRefresh = e.target.checked;
      setupAutoRefresh();
    });
    el.querySelector("#chat-clear-btn")?.addEventListener("click", onClearAll);
    el.querySelector("#chat-notif-btn")?.addEventListener("click", onToggleNotifications);
    el.querySelector("#chat-attach-btn").addEventListener("click", () => el.querySelector("#chat-file-input").click());
    el.querySelector("#chat-file-input").addEventListener("change", (e) => {
      s.pendingFile = e.target.files[0] || null;
      draw();
    });
    el.querySelector("#chat-remove-file")?.addEventListener("click", () => { s.pendingFile = null; draw(); });
    el.querySelector("#chat-send-btn").addEventListener("click", onSend);
    el.querySelector("#chat-text-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") onSend();
    });
    el.querySelectorAll("[data-delete-msg]").forEach((btn) => {
      btn.addEventListener("click", () => onDeleteMessage(btn.dataset.deleteMsg, btn.dataset.imageUrl || ""));
    });

    if (preserveScroll) scrollToBottom();
  }

  function drawMessages() {
    const list = el.querySelector("#chat-list");
    if (!list) { draw(); return; } // shell not mounted yet -- fall back to a full draw
    list.innerHTML = s.messages.length
      ? s.messages.map((m) => chatMsgHtml(m)).join("")
      : `<div class="hint">No messages yet -- be the first to say something.</div>`;
    list.querySelectorAll("[data-delete-msg]").forEach((btn) => {
      btn.addEventListener("click", () => onDeleteMessage(btn.dataset.deleteMsg, btn.dataset.imageUrl || ""));
    });
  }

  function chatMsgHtml(m) {
    const mine = m.user_id === user.id;
    let timeStr = "";
    try {
      timeStr = new Date(m.created_at).toLocaleString("en-US", {
        weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
      });
    } catch (_) {}
    return `
      <div class="chat-msg ${mine ? "mine" : ""}">
        <div class="meta">${escapeHtml(m.username)} &middot; ${escapeHtml(timeStr)}</div>
        <div class="bubble">
          ${m.message ? `<div>${escapeHtml(m.message)}</div>` : ""}
          ${m.image_url ? `<img src="${escapeHtml(m.image_url)}" alt="attachment" loading="lazy">` : ""}
        </div>
        ${isAdmin ? `<div><button class="chat-delete" data-delete-msg="${m.id}" data-image-url="${escapeHtml(m.image_url || "")}">\u{1F5D1}️ Delete</button></div>` : ""}
      </div>
    `;
  }

  function notifButtonHtml() {
    if (s.notifState === "unsupported" || s.notifState === "checking") return "";
    if (s.notifState === "denied") {
      return `<span class="hint" style="margin-left:2px;">\u{1F515} Notifications blocked -- enable in browser settings</span>`;
    }
    const on = s.notifState === "subscribed";
    return `<button class="btn btn-secondary" id="chat-notif-btn" style="width:auto; padding:8px 12px;">${on ? "\u{1F514} Notifications on" : "\u{1F515} Enable notifications"}</button>`;
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

  async function onSend() {
    const textInput = el.querySelector("#chat-text-input");
    const text = (textInput.value || "").trim();
    let imageUrl = null;

    if (s.pendingFile) {
      try {
        const ext = s.pendingFile.name.includes(".") ? s.pendingFile.name.split(".").pop().toLowerCase() : "png";
        const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage.from("chat-images").upload(path, s.pendingFile, {
          contentType: s.pendingFile.type || "application/octet-stream",
        });
        if (upErr) throw upErr;
        const { data } = supabase.storage.from("chat-images").getPublicUrl(path);
        imageUrl = data.publicUrl;
      } catch (e) {
        s.error = "Image upload failed: " + (e.message || e);
        draw();
        return;
      }
    }

    if (!text && !imageUrl) return;

    const { error } = await supabase.from("chat_messages").insert({
      user_id: user.id, username, message: text || null, image_url: imageUrl,
    });
    if (error) { s.error = "Database error: " + error.message; draw(); return; }

    textInput.value = "";
    s.pendingFile = null;
    s.error = "";
    await loadMessages(true);
  }

  async function onDeleteMessage(id, imageUrl) {
    try {
      const path = storagePathFromUrl(imageUrl);
      if (path) {
        try { await supabase.storage.from("chat-images").remove([path]); } catch (_) {}
      }
      const { error } = await supabase.from("chat_messages").delete().eq("id", id);
      if (error) throw error;
      await loadMessages(true);
    } catch (e) {
      s.error = "Database error: " + (e.message || e);
      draw();
    }
  }

  async function onClearAll() {
    if (!confirm("This will permanently delete every message in this chat, including any uploaded images/gifs. This cannot be undone. Continue?")) return;
    try {
      const { data: allMsgs } = await supabase.from("chat_messages").select("image_url");
      const paths = (allMsgs || []).map((m) => storagePathFromUrl(m.image_url)).filter(Boolean);
      if (paths.length) {
        try { await supabase.storage.from("chat-images").remove(paths); } catch (_) {}
      }
      const { error } = await supabase.from("chat_messages").delete().gte("id", 0);
      if (error) throw error;
      await loadMessages(true);
    } catch (e) {
      s.error = "Database error: " + (e.message || e);
      draw();
    }
  }

  async function loadMessages(preserveScroll, backgroundOnly) {
    try {
      const { data, error } = await supabase.from("chat_messages").select("*").order("created_at", { ascending: true });
      if (error) throw error;
      s.messages = data || [];
      s.loading = false;
      if (backgroundOnly && el.querySelector("#chat-list")) {
        drawMessages();
        if (preserveScroll) scrollToBottom();
      } else {
        draw(preserveScroll);
      }
    } catch (e) {
      s.loading = false;
      s.error = e.message || "Couldn't load chat.";
      draw();
    }
  }

  function setupAutoRefresh() {
    if (timer) clearInterval(timer);
    if (s.autoRefresh) timer = setInterval(() => loadMessages(false, true), s.intervalSec * 1000);
  }

  loadMessages(true).then(setupAutoRefresh);
  if (pushSupported()) {
    getPushState().then((st) => { s.notifState = st; draw(); });
  } else {
    s.notifState = "unsupported";
  }
  draw();

  const observer = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      if (timer) clearInterval(timer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
