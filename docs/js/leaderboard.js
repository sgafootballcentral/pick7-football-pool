import { escapeHtml, avatarInnerHtml, fetchAvatarsByUsername } from "./app.js";
import { getSharedWeek, setSharedWeek } from "./weekState.js";

const MEDALS = { 1: "\u{1F947}", 2: "\u{1F948}", 3: "\u{1F949}" };

export function renderLeaderboard(el, { supabase, user, username }) {
  // Falls back to Week 1 only if the Picks tab hasn't set a week yet this
  // session (Picks is the default tab, so in practice this almost always
  // already reflects whatever week the player was just looking at there).
  const s = {
    loading: true, error: "", picksData: [], avatars: {}, selectedWeek: getSharedWeek() || 1,
    profile: null, // { userId, username } when the profile sheet is open
    dm: null, // { otherId, otherUsername, messages, loading } when a DM thread is open
  };
  let dmTimer = null;

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

    const hasAnyGraded = s.picksData.some((r) => r.wins > 0 || r.losses > 0);
    if (!hasAnyGraded) {
      const roster = [...new Set(s.picksData.map((p) => p.username))];
      el.innerHTML = `
        <h2>\u{1F3C6} League Standings</h2>
        <div class="card">\u{1F3C8} Total standings will update here as soon as games are graded.</div>
        <h3>Active League Roster</h3>
        <div class="card">${roster.map((u) => `
          <div class="player-with-avatar" style="margin-bottom:6px;">
            <span class="avatar-circle-sm">${avatarInnerHtml(s.avatars[u]?.url, s.avatars[u]?.monogram, u)}</span>${escapeHtml(u)}
          </div>
        `).join("")}</div>
      `;
      return;
    }

    // Keyed by the stable user_id, never by the display name -- a rename
    // can never split or orphan someone's record here, because
    // picks_week_tallies (see the "avatars everywhere" migration) groups
    // by user_id in Postgres and joins in whatever the player's CURRENT
    // name is, live, every time this loads.
    const byPlayer = {};
    for (const r of s.picksData) {
      const rec = (byPlayer[r.user_id] ||= { user_id: r.user_id, username: r.username, wins: 0, losses: 0 });
      rec.wins += r.wins;
      rec.losses += r.losses;
    }
    const standings = Object.values(byPlayer).filter((r) => r.wins + r.losses > 0);
    standings.forEach((r) => (r.winPct = r.wins / (r.wins + r.losses)));
    standings.sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses));

    // Rank by wins, ties share a place (1-2-2-4), same as Excel's RANK().
    let lastWins = null, lastPlace = 0;
    standings.forEach((r, i) => {
      if (r.wins !== lastWins) { lastPlace = i + 1; lastWins = r.wins; }
      r.place = lastPlace;
    });

    // Rank change vs. the standings as of the week before the most recent
    // one with any graded games -- a lightweight "last week" comparison
    // computed from the same picks_week_tallies rows already loaded, no
    // extra query needed.
    const weeksWithData = [...new Set(s.picksData.filter((r) => r.wins + r.losses > 0).map((r) => r.week_number))].sort((a, b) => a - b);
    const latestWeek = weeksWithData[weeksWithData.length - 1];
    const priorByPlayer = {};
    if (latestWeek != null) {
      for (const r of s.picksData) {
        if (r.week_number >= latestWeek) continue;
        const rec = (priorByPlayer[r.user_id] ||= { wins: 0, losses: 0 });
        rec.wins += r.wins;
        rec.losses += r.losses;
      }
    }
    const priorList = Object.entries(priorByPlayer)
      .map(([uid, rec]) => ({ user_id: uid, ...rec }))
      .filter((r) => r.wins + r.losses > 0);
    priorList.sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses));
    let plw = null, plp = 0;
    priorList.forEach((r, i) => { if (r.wins !== plw) { plp = i + 1; plw = r.wins; } r.place = plp; });
    const priorPlaceByUser = Object.fromEntries(priorList.map((r) => [r.user_id, r.place]));

    function rankChipHtml(r) {
      const prior = priorPlaceByUser[r.user_id];
      if (prior == null) return `<span class="rank-chip same">NEW</span>`;
      const delta = prior - r.place;
      if (delta > 0) return `<span class="rank-chip up">▲${delta}</span>`;
      if (delta < 0) return `<span class="rank-chip down">▼${-delta}</span>`;
      return `<span class="rank-chip same">–</span>`;
    }

    // The view already has (at most) one row per player per week, so this
    // is a direct lookup rather than a re-aggregation.
    const weekByPlayer = {};
    for (const r of s.picksData) {
      if (r.week_number === s.selectedWeek) weekByPlayer[r.user_id] = { wins: r.wins, losses: r.losses };
    }

    const weekOptions = Array.from({ length: 16 }, (_, i) => i + 1);

    const podiumPlayers = standings.slice(0, 3);
    const restPlayers = standings.slice(3);
    const podiumOrder = podiumPlayers.length === 3 ? [podiumPlayers[1], podiumPlayers[0], podiumPlayers[2]] : podiumPlayers;
    const podiumRankClass = (r) => (r === podiumPlayers[0] ? "first" : r === podiumPlayers[1] ? "second" : "third");

    function podiumItemHtml(r) {
      if (!r) return `<div class="podium-item" style="visibility:hidden;"></div>`;
      const cls = podiumRankClass(r);
      const wk = weekByPlayer[r.user_id] || { wins: 0, losses: 0 };
      return `
        <button type="button" class="podium-item ${cls}" data-open-profile="${escapeHtml(r.user_id)}" data-open-profile-name="${escapeHtml(r.username)}">
          <div class="podium-avatar-wrap">
            <span class="avatar-circle-lg" style="${cls === "first" ? "width:62px;height:62px;font-size:1.3rem;" : "width:48px;height:48px;font-size:1rem;"}">${avatarInnerHtml(s.avatars[r.username]?.url, s.avatars[r.username]?.monogram, r.username)}</span>
            <span class="podium-medal">${MEDALS[cls === "first" ? 1 : cls === "second" ? 2 : 3]}</span>
          </div>
          <div class="podium-name">${escapeHtml(r.username)}</div>
          <div class="podium-record">${r.wins}–${r.losses} <span style="opacity:0.7;">overall</span></div>
          <div class="podium-record">Wk ${s.selectedWeek}: ${wk.wins}–${wk.losses}</div>
          <div class="podium-platform">${r.place}</div>
        </button>
      `;
    }

    el.innerHTML = `
      <h2>\u{1F3C6} League Standings</h2>
      <div class="week-select-row">
        <label class="hint" style="white-space:nowrap;">Show record for week:</label>
        <select id="lb-week-select">
          ${weekOptions.map((w) => `<option value="${w}" ${w === s.selectedWeek ? "selected" : ""}>${w}</option>`).join("")}
        </select>
      </div>

      ${podiumPlayers.length ? `<div class="podium">${podiumOrder.map(podiumItemHtml).join("")}</div>` : ""}

      <div style="overflow-x:auto;">
        <table class="standings">
          <thead><tr><th>Rank</th><th>Player</th><th>Overall</th><th>Week ${s.selectedWeek}</th><th>Win %</th><th>Trend</th></tr></thead>
          <tbody>
            ${(restPlayers.length ? restPlayers : standings).map((r) => {
              const wk = weekByPlayer[r.user_id] || { wins: 0, losses: 0 };
              const rankClass = r.place <= 3 ? `rank-${r.place}` : "";
              const isMe = r.user_id === user.id;
              return `<tr class="standings-clickable ${isMe ? "standings-me" : ""}" data-open-profile="${escapeHtml(r.user_id)}" data-open-profile-name="${escapeHtml(r.username)}">
                <td class="${rankClass}">${MEDALS[r.place] || r.place}</td>
                <td><span class="player-with-avatar"><span class="avatar-circle-sm">${avatarInnerHtml(s.avatars[r.username]?.url, s.avatars[r.username]?.monogram, r.username)}</span>${escapeHtml(r.username)}${isMe ? ` <span class="hint">(you)</span>` : ""}</span></td>
                <td>${r.wins} | ${r.losses}</td>
                <td>${wk.wins} | ${wk.losses}</td>
                <td>${(r.winPct * 100).toFixed(1)}%</td>
                <td>${rankChipHtml(r)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      <div class="hint" style="margin-top:8px;">Tap a player to see their picture, full record, and send them a message.</div>
    `;

    el.querySelector("#lb-week-select").addEventListener("change", (e) => {
      s.selectedWeek = Number(e.target.value);
      setSharedWeek(s.selectedWeek);
      draw();
    });

    el.querySelectorAll("[data-open-profile]").forEach((node) => {
      node.addEventListener("click", () => {
        openProfile(node.dataset.openProfile, node.dataset.openProfileName);
      });
    });

    const modalAlreadyOpen = !!document.querySelector(".modal-backdrop");
    if (s.profile && !modalAlreadyOpen) drawProfileModal(byPlayer);
    if (s.dm && !modalAlreadyOpen) drawDmModal();
  }

  function openProfile(userId, uname) {
    s.profile = { userId, username: uname };
    draw();
  }

  function drawProfileModal(byPlayer) {
    const { userId, username: uname } = s.profile;
    const rec = byPlayer[userId] || { wins: 0, losses: 0 };
    const weeks = s.picksData
      .filter((r) => r.user_id === userId && r.wins + r.losses > 0)
      .sort((a, b) => a.week_number - b.week_number);
    const isMe = userId === user.id;

    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <div class="modal-sheet">
        <div class="profile-head">
          <span class="avatar-circle-lg profile-avatar-xl">${avatarInnerHtml(s.avatars[uname]?.url, s.avatars[uname]?.monogram, uname)}</span>
          <h2 style="margin:0;">${escapeHtml(uname)}${isMe ? ` <span class="hint">(you)</span>` : ""}</h2>
          <div class="hint">${rec.wins}–${rec.losses} overall · ${rec.wins + rec.losses ? ((rec.wins / (rec.wins + rec.losses)) * 100).toFixed(1) : "0.0"}% win rate</div>
        </div>
        ${weeks.length ? `
          <table class="profile-weeks">
            <thead><tr><th>Week</th><th>W</th><th>L</th></tr></thead>
            <tbody>${weeks.map((w) => `<tr><td>${w.week_number}</td><td>${w.wins}</td><td>${w.losses}</td></tr>`).join("")}</tbody>
          </table>
        ` : `<div class="hint" style="text-align:center;">No graded weeks yet.</div>`}
        <div class="btn-row" style="margin-top:14px;">
          ${!isMe ? `<button class="btn btn-primary" id="profile-message-btn">\u{1F4AC} Message ${escapeHtml(uname)}</button>` : ""}
          <button class="btn btn-secondary" id="profile-close-btn">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    wrap.querySelector("#profile-close-btn").addEventListener("click", () => {
      s.profile = null;
      wrap.remove();
    });
    wrap.querySelector("#profile-message-btn")?.addEventListener("click", () => {
      s.profile = null;
      wrap.remove();
      openDmThread(userId, uname);
    });
  }

  async function openDmThread(otherId, otherUsername) {
    s.dm = { otherId, otherUsername, messages: [], loading: true };
    draw();
    await loadDm();
    if (dmTimer) clearInterval(dmTimer);
    dmTimer = setInterval(loadDm, 4000);
  }

  function closeDm() {
    s.dm = null;
    if (dmTimer) { clearInterval(dmTimer); dmTimer = null; }
  }

  async function loadDm() {
    if (!s.dm) return;
    try {
      const { otherId } = s.dm;
      const { data, error } = await supabase.from("direct_messages").select("*")
        .or(`and(sender_id.eq.${user.id},recipient_id.eq.${otherId}),and(sender_id.eq.${otherId},recipient_id.eq.${user.id})`)
        .order("created_at", { ascending: true });
      if (error) throw error;
      s.dm.messages = data || [];
      s.dm.loading = false;
      redrawDmModal();
    } catch (e) {
      s.dm.loading = false;
      s.dm.error = e.message || "Couldn't load messages.";
      redrawDmModal();
    }
  }

  function dmMsgHtml(m) {
    const mine = m.sender_id === user.id;
    let timeStr = "";
    try {
      timeStr = new Date(m.created_at).toLocaleString("en-US", {
        month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
      });
    } catch (_) {}
    return `
      <div class="dm-msg ${mine ? "mine" : ""}">
        <div class="meta">${mine ? "You" : escapeHtml(s.dm.otherUsername)} · ${escapeHtml(timeStr)}</div>
        <div class="bubble">${escapeHtml(m.message)}</div>
      </div>
    `;
  }

  function drawDmModal() {
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.id = "dm-modal-backdrop";
    renderDmInner(wrap);
    document.body.appendChild(wrap);
  }

  function renderDmInner(wrap) {
    const { otherUsername, messages, loading, error } = s.dm;
    wrap.innerHTML = `
      <div class="modal-sheet">
        <h2 style="display:flex; align-items:center; gap:8px;">
          <span class="avatar-circle-sm">${avatarInnerHtml(s.avatars[otherUsername]?.url, s.avatars[otherUsername]?.monogram, otherUsername)}</span>
          ${escapeHtml(otherUsername)}
        </h2>
        ${error ? `<div class="error-msg">${escapeHtml(error)}</div>` : ""}
        <div class="dm-list" id="dm-list">
          ${loading ? `<div class="centered" style="min-height:0; padding:20px 0;"><div class="loading-spinner"></div></div>` : (
            messages.length ? messages.map(dmMsgHtml).join("") : `<div class="hint" style="text-align:center;">No messages yet — say hi!</div>`
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

    wrap.querySelector("#dm-close-btn").addEventListener("click", () => {
      closeDm();
      wrap.remove();
    });
    const sendBtn = wrap.querySelector("#dm-send-btn");
    const textInput = wrap.querySelector("#dm-text-input");
    const send = async () => {
      const text = (textInput.value || "").trim();
      if (!text || !s.dm) return;
      sendBtn.disabled = true;
      try {
        const { error: insErr } = await supabase.from("direct_messages").insert({
          sender_id: user.id, recipient_id: s.dm.otherId, message: text,
        });
        if (insErr) throw insErr;
        textInput.value = "";
        await loadDm();
      } catch (e) {
        s.dm.error = "Couldn't send: " + (e.message || e);
        redrawDmModal();
      } finally {
        sendBtn.disabled = false;
      }
    };
    sendBtn.addEventListener("click", send);
    textInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
  }

  function redrawDmModal() {
    const wrap = document.getElementById("dm-modal-backdrop");
    if (wrap) renderDmInner(wrap);
  }

  (async function init() {
    try {
      // picks_week_tallies is a Postgres view (user_id + week_number -> wins/
      // losses, with the player's current name joined in live) instead of
      // raw picks rows. Two things this fixes at once: (1) the raw picks
      // table recently passed Supabase's default 1000-row API cap, which
      // was silently truncating this unfiltered select and producing
      // wrong, randomly-shifting totals; (2) grouping by user_id instead
      // of by username means a display-name change can never split or
      // orphan anyone's record again, however the rename happens.
      const [{ data, error }, avatars] = await Promise.all([
        supabase.from("picks_week_tallies").select("user_id, username, week_number, wins, losses"),
        fetchAvatarsByUsername(supabase),
      ]);
      if (error) throw error;
      s.picksData = data || [];
      s.avatars = avatars;
      s.loading = false;
      draw();
    } catch (e) {
      s.loading = false;
      s.error = e.message || "Couldn't load standings.";
      draw();
    }
  })();

  draw();

  const observer = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      if (dmTimer) clearInterval(dmTimer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
