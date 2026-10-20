import { escapeHtml } from "./app.js";

function storagePathFromUrl(url) {
  if (!url) return null;
  const marker = "/chat-images/";
  const idx = url.indexOf(marker);
  return idx === -1 ? null : url.slice(idx + marker.length);
}

// Long-press on a message (or the reaction-add button) opens a picker with
// these six, plus a "more" button that focuses a hidden text input so the
// user can switch their OS/browser keyboard into emoji mode and type one.
const REACTION_EMOJIS = ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F525}"];

function buildReactionsByMessage(rows, myUserId) {
  const map = {};
  for (const r of rows || []) {
    const byEmoji = (map[r.message_id] ||= {});
    const entry = (byEmoji[r.emoji] ||= { count: 0, mine: false, usernames: [] });
    entry.count++;
    entry.usernames.push(r.username || "Someone");
    if (r.user_id === myUserId) entry.mine = true;
  }
  return map;
}

function reactionsSignature(map) {
  return Object.keys(map).sort().map((mid) => {
    const byEmoji = map[mid];
    return mid + ":" + Object.keys(byEmoji).sort()
      .map((e) => `${e}=${byEmoji[e].count}${byEmoji[e].mine ? "m" : ""}`).join(",");
  }).join("|");
}

export function renderChat(el, { supabase, user, username, isAdmin }) {
  const s = {
    loading: true, error: "", messages: [], autoRefresh: true, intervalSec: 5, pendingFile: null,
    reactionsByMessage: {}, openPickerFor: null, pickerShowInput: null,
  };
  let timer = null;

  function scrollToBottom() {
    const list = el.querySelector("#chat-list");
    if (!list) return;

    const settle = () => {
      // Overshoot on purpose -- scrollTop silently clamps to the real max,
      // so this safely covers the max being computed a hair short
      // (subpixel rounding, a reflow that hasn't fully settled yet).
      list.scrollTop = list.scrollHeight + 1000;
      // .chat-input-row sits AFTER (not inside) #chat-list, and the whole
      // chat screen (heading, buttons, message list, input row) can be
      // taller than the viewport -- so maxing out the inner list's own
      // scroll isn't enough, the outer page needs to scroll down too, or
      // the input row/newest message can stay below the fold. scrollIntoView
      // walks up through every scrollable ancestor, not just the nearest
      // one, so this brings both into view together.
      el.querySelector("#chat-send-btn")?.scrollIntoView({ block: "end" });
    };

    settle();
    // Re-run once the browser has actually finished laying out this frame
    // -- measuring scrollHeight right after innerHTML is set can land a
    // hair early (e.g. before a line-height/font reflow finishes), which
    // is what left the last line half-clipped.
    requestAnimationFrame(() => requestAnimationFrame(settle));
    // Images load asynchronously and grow the list after the lines above
    // run -- without this, the view lands short of the true bottom
    // whenever the newest message (or one just above it) has an image.
    list.querySelectorAll("img").forEach((img) => {
      if (!img.complete) {
        img.addEventListener("load", settle, { once: true });
      }
    });
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
        ${isAdmin ? `<button class="btn btn-secondary" id="chat-clear-btn" style="width:auto; padding:8px 12px; margin-left:auto;">\u{1F5D1}️ Clear All</button>` : ""}
      </div>
      ${s.error ? `<div class="error-msg">${escapeHtml(s.error)}</div>` : ""}
      <div class="chat-list" id="chat-list" style="max-height:55vh; overflow-y:auto;">
        ${s.messages.length ? s.messages.map((m) => chatMsgHtml(m)).join("") : `<div class="hint">No messages yet -- be the first to say something.</div>`}
      </div>
      <div class="chat-input-row">
        <input type="file" id="chat-file-input" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none;">
        <button class="btn btn-secondary" id="chat-attach-btn" style="width:auto; padding:11px 12px;">\u{1F4CE}</button>
        <textarea id="chat-text-input" placeholder="Type a message…" rows="1"></textarea>
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
    el.querySelector("#chat-attach-btn").addEventListener("click", () => el.querySelector("#chat-file-input").click());
    el.querySelector("#chat-file-input").addEventListener("change", (e) => {
      s.pendingFile = e.target.files[0] || null;
      draw();
    });
    el.querySelector("#chat-remove-file")?.addEventListener("click", () => { s.pendingFile = null; draw(); });
    el.querySelector("#chat-send-btn").addEventListener("click", onSend);
    {
      const chatTextInput = el.querySelector("#chat-text-input");
      // Grow the box with the message instead of letting long text scroll
      // sideways inside a fixed-height field.
      const autoResizeChatInput = () => {
        chatTextInput.style.height = "auto";
        chatTextInput.style.height = Math.min(chatTextInput.scrollHeight, 120) + "px";
      };
      chatTextInput.addEventListener("input", autoResizeChatInput);
      chatTextInput.addEventListener("keydown", (e) => {
        // Enter sends; Shift+Enter inserts a newline like a normal chat app.
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onSend();
        }
      });
    }
    wireMessageInteractions(el);

    if (preserveScroll) scrollToBottom();
  }

  function messagesSignature(msgs) {
    return msgs.map((m) => m.id).join(",");
  }

  function drawMessages() {
    const list = el.querySelector("#chat-list");
    if (!list) { draw(); return; } // shell not mounted yet -- fall back to a full draw
    list.innerHTML = s.messages.length
      ? s.messages.map((m) => chatMsgHtml(m)).join("")
      : `<div class="hint">No messages yet -- be the first to say something.</div>`;
    wireMessageInteractions(list);
  }

  // Shared by draw() (full rebuild) and drawMessages() (list-only patch) so
  // every message row -- delete button, long-press-to-react, reaction chips,
  // and the picker itself once opened -- gets its listeners either way.
  function wireMessageInteractions(scope) {
    scope.querySelectorAll("[data-delete-msg]").forEach((btn) => {
      btn.addEventListener("click", () => onDeleteMessage(btn.dataset.deleteMsg, btn.dataset.imageUrl || ""));
    });

    // Long-press: pointerdown starts a timer; pointermove past a small
    // threshold (a scroll, not a press-and-hold) or pointerup/cancel before
    // it fires cancels it. Covers touch and mouse alike via Pointer Events,
    // so a trackpad click-and-hold on desktop opens the picker too.
    scope.querySelectorAll(".bubble[data-msg-id]").forEach((bubble) => {
      let pressTimer = null;
      let startX = 0, startY = 0;
      const clearPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
      bubble.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        startX = e.clientX; startY = e.clientY;
        clearPress();
        pressTimer = setTimeout(() => openPicker(bubble.dataset.msgId), 450);
      });
      bubble.addEventListener("pointermove", (e) => {
        if (!pressTimer) return;
        if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) clearPress();
      });
      ["pointerup", "pointercancel", "pointerleave"].forEach((evt) => bubble.addEventListener(evt, clearPress));
    });

    scope.querySelectorAll("[data-open-picker]").forEach((btn) => {
      btn.addEventListener("click", () => openPicker(btn.dataset.openPicker));
    });
    scope.querySelectorAll("[data-close-picker]").forEach((btn) => {
      btn.addEventListener("click", closePicker);
    });
    scope.querySelectorAll("[data-more-picker]").forEach((btn) => {
      btn.addEventListener("click", () => {
        // Hands off to the device's own emoji keyboard: there's no web API
        // to force "emoji mode", so this just focuses an ordinary text
        // input -- on iOS/Android the user taps the keyboard's emoji/globe
        // key, on a Mac desktop they can use Cmd+Ctrl+Space -- and whatever
        // they end up typing there is taken as the reaction.
        s.pickerShowInput = btn.dataset.morePicker;
        drawMessages();
        const input = el.querySelector(`#reaction-emoji-input-${btn.dataset.morePicker}`);
        input?.focus();
      });
    });
    scope.querySelectorAll("[data-react-msg]").forEach((btn) => {
      btn.addEventListener("click", () => toggleReaction(btn.dataset.reactMsg, btn.dataset.reactEmoji));
    });
    scope.querySelectorAll(".reaction-emoji-input").forEach((input) => {
      const commit = () => {
        const val = (input.value || "").trim();
        const msgId = input.id.replace("reaction-emoji-input-", "");
        if (val) toggleReaction(msgId, val);
        else closePicker();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); closePicker(); }
      });
      input.addEventListener("blur", commit);
    });
  }

  function openPicker(msgId) {
    s.openPickerFor = String(msgId);
    s.pickerShowInput = null;
    drawMessages();
  }

  function closePicker() {
    s.openPickerFor = null;
    s.pickerShowInput = null;
    drawMessages();
  }

  async function toggleReaction(messageId, emoji) {
    const mid = Number(messageId);
    const mine = s.reactionsByMessage[mid]?.[emoji]?.mine;
    closePicker();
    try {
      // Only one reaction per person per message -- clear whatever this
      // user already has here before adding the new one. Re-picking the
      // same emoji they already had just removes it, with no replacement.
      await supabase.from("chat_reactions").delete().eq("message_id", mid).eq("user_id", user.id);
      if (!mine) {
        await supabase.from("chat_reactions").insert({ message_id: mid, user_id: user.id, username, emoji });
      }
      await loadMessages(false, true);
    } catch (e) {
      s.error = "Couldn't update reaction: " + (e.message || e);
      draw();
    }
  }

  // Long-press (see wireMessageInteractions()) sets openPickerFor and we
  // just redraw -- so the picker lives right in this message's own markup
  // rather than as a floating, separately-positioned popover.
  function reactionPickerHtml(m) {
    if (String(s.openPickerFor) !== String(m.id)) return "";
    const quickButtons = REACTION_EMOJIS.map((e) =>
      `<button class="reaction-pick-btn" data-react-msg="${m.id}" data-react-emoji="${escapeHtml(e)}">${e}</button>`
    ).join("");
    const showInput = String(s.pickerShowInput) === String(m.id);
    return `
      <div class="reaction-picker">
        ${quickButtons}
        <button class="reaction-pick-more" data-more-picker="${m.id}" title="More emoji">➕</button>
        <button class="reaction-pick-close" data-close-picker="${m.id}" title="Close">✕</button>
        ${showInput ? `<input type="text" class="reaction-emoji-input" id="reaction-emoji-input-${m.id}" maxlength="8" placeholder="pick an emoji…">` : ""}
      </div>
    `;
  }

  function reactionRowHtml(m) {
    const byEmoji = s.reactionsByMessage[m.id] || {};
    const emojiKeys = Object.keys(byEmoji);
    if (!emojiKeys.length) return "";
    const chips = emojiKeys.map((emoji) => {
      const entry = byEmoji[emoji];
      const title = entry.usernames.join(", ");
      return `<button class="reaction-chip ${entry.mine ? "mine" : ""}" data-react-msg="${m.id}" data-react-emoji="${escapeHtml(emoji)}" title="${escapeHtml(title)}">${emoji} ${entry.count}</button>`;
    }).join("");
    return `<div class="reaction-row">${chips}</div>`;
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
        <div class="bubble" data-msg-id="${m.id}">
          ${m.message ? `<div>${escapeHtml(m.message)}</div>` : ""}
          ${m.image_url ? `<img src="${escapeHtml(m.image_url)}" alt="attachment" loading="lazy">` : ""}
        </div>
        ${reactionPickerHtml(m)}
        ${reactionRowHtml(m)}
        <div class="msg-footer">
          <button class="reaction-add-btn" data-open-picker="${m.id}">\u{1F642}+</button>
          ${isAdmin ? `<button class="chat-delete" data-delete-msg="${m.id}" data-image-url="${escapeHtml(m.image_url || "")}">\u{1F5D1}️ Delete</button>` : ""}
        </div>
      </div>
    `;
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
      // message is NOT NULL in the database (the Streamlit app relies on
      // this too) -- an image-only message must still send an empty string,
      // never null, or the insert is rejected.
      user_id: user.id, username, message: text, image_url: imageUrl,
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
      const [{ data: msgData, error: msgErr }, { data: reactData, error: reactErr }] = await Promise.all([
        supabase.from("chat_messages").select("*").order("created_at", { ascending: true }),
        supabase.from("chat_reactions").select("*"),
      ]);
      if (msgErr) throw msgErr;
      if (reactErr) throw reactErr;
      const newMessages = msgData || [];
      const newReactions = buildReactionsByMessage(reactData, user.id);
      // Reactions changing (someone else's tap) doesn't add/remove a message
      // row, so the message-id signature alone would miss it -- compare both.
      const changed = messagesSignature(newMessages) !== messagesSignature(s.messages)
        || reactionsSignature(newReactions) !== reactionsSignature(s.reactionsByMessage);
      s.messages = newMessages;
      s.reactionsByMessage = newReactions;
      s.loading = false;
      if (backgroundOnly && el.querySelector("#chat-list")) {
        // Skip touching the DOM at all when nothing actually changed --
        // rewriting the (identical) list every 5s was what caused the
        // visible screen flash, since it forced a repaint (and reloaded
        // any images) even with no new messages.
        if (changed) {
          drawMessages();
          if (preserveScroll) scrollToBottom();
        }
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
  draw();

  const observer = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      if (timer) clearInterval(timer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
